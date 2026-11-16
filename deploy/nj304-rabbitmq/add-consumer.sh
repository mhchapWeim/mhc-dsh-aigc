#!/usr/bin/env bash
# Run on a machine with kubectl access to the RabbitMQ deployment.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; then
  echo "Usage: bash add-consumer.sh <service-name> (lowercase letters, digits, hyphens)" >&2
  exit 2
fi
command -v kubectl >/dev/null
command -v python3 >/dev/null
export AIGC_NEW_SERVICE="$1"
export AIGC_MQ_NAMESPACE="${AIGC_MQ_NAMESPACE:-bosch-aigc-dsh}"
export AIGC_MQ_LOCAL_PORT="${AIGC_MQ_LOCAL_PORT:-18672}"
python3 - <<'PY'
import base64
import getpass
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

service = os.environ['AIGC_NEW_SERVICE']
namespace = os.environ['AIGC_MQ_NAMESPACE']
port = int(os.environ['AIGC_MQ_LOCAL_PORT'])
queue = 'aigc.users.' + service
user = 'aigc_user_' + service.replace('-', '_')
print('MQ administrator username [aigc_mq_admin]: ', end='', flush=True)
with open('/dev/tty') as terminal:
    admin = terminal.readline().strip() or 'aigc_mq_admin'
admin_password = getpass.getpass('MQ administrator password: ')
password = getpass.getpass('New consumer password (at least 16 characters): ')
if len(password) < 16 or password != getpass.getpass('Confirm new consumer password: '):
    raise SystemExit('Password too short or confirmation mismatch; no changes made.')
authorization = 'Basic ' + base64.b64encode((admin + ':' + admin_password).encode()).decode()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def api(method, path, body=None, missing_ok=False):
    request = urllib.request.Request(
        'http://127.0.0.1:%d/api/%s' % (port, path),
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={'Authorization': authorization, 'Content-Type': 'application/json'})
    try:
        with opener.open(request, timeout=15) as response:
            content = response.read()
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as error:
        if missing_ok and error.code == 404:
            return None
        raise RuntimeError('MQ API %s %s returned HTTP %s' % (method, path, error.code)) from None

quote = lambda value: urllib.parse.quote(value, safe='')
with tempfile.TemporaryFile() as log:
    process = subprocess.Popen([
        'kubectl', 'port-forward', '-n', namespace, 'service/aigc-mq',
        '%d:15672' % port, '--address=127.0.0.1'], stdout=log, stderr=log)
    try:
        for attempt in range(50):
            if process.poll() is not None:
                raise RuntimeError('kubectl port-forward exited; check cluster access and local port availability.')
            try:
                api('GET', 'overview')
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.2)
        else:
            raise RuntimeError('Timed out waiting for RabbitMQ management endpoint.')
        if api('GET', 'users/' + quote(user), missing_ok=True) is not None:
            raise RuntimeError('Consumer account already exists; refusing to change its password or permissions.')
        if api('GET', 'queues/%2Faigc/' + quote(queue), missing_ok=True) is not None:
            raise RuntimeError('Queue already exists; refusing to modify an existing service queue.')
        exchange = api('GET', 'exchanges/%2Faigc/aigc.identity.users')
        if exchange['type'] != 'topic':
            raise RuntimeError('Expected existing topic exchange aigc.identity.users.')
        api('PUT', 'queues/%2Faigc/' + quote(queue), {
            'durable': True, 'auto_delete': False, 'arguments': {'x-queue-type': 'quorum'}})
        api('POST', 'bindings/%2Faigc/e/aigc.identity.users/q/' + quote(queue), {
            'routing_key': 'aigc.user.*.v1', 'arguments': {}})
        api('PUT', 'users/' + quote(user), {'password': password, 'tags': ''})
        # Queue names contain only the validated service slug and fixed dots.
        read_pattern = '^' + queue.replace('.', r'\.') + '$'
        api('PUT', 'permissions/%2Faigc/' + quote(user), {
            'configure': '^$', 'write': '^$', 'read': read_pattern})
        consumers = api('GET', 'queues/%2Faigc/' + quote(queue))
        permissions = api('GET', 'permissions/%2Faigc/' + quote(user))
        if not consumers['durable'] or permissions['read'] != read_pattern:
            raise RuntimeError('Post-creation verification failed.')
        print('\nCreated and verified consumer access:')
        print('Cluster endpoint: aigc-mq.%s.svc:5672' % namespace)
        print('External endpoint: <reachable-node-address>:30672 (verify your Service configuration)')
        print('Virtual host: /aigc\nQueue: %s\nUsername: %s' % (queue, user))
        print('Exchange: aigc.identity.users\nBinding: aigc.user.*.v1')
        print('Password: the value you entered; not printed or saved by this script.')
        print('Consume the existing queue with manual ACK after database commit; do not declare topology.')
        print('Configure the receiver, then trigger a full snapshot in AIGC. Existing services also receive it.')
        print('Back up broker definitions using your normal process; retain credentials securely.')
    except Exception as error:
        raise SystemExit('%s\nCreation may be partial; inspect MQ before rerunning. No resources were deleted.' % error)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
PY
