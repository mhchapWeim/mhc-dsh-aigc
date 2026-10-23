"""Validate existing MinIO resources; create private credentials only on real update."""
import base64
import json
import os
import pathlib
import secrets
import sys

root = pathlib.Path(sys.argv[1])
def read(name):
    path = root / f'minio-{name}.json'
    text = path.read_text().strip()
    return json.loads(text) if text else None

pv = read('pv')
if pv:
    spec = pv['spec']
    assert spec.get('local', {}).get('path') == '/var/lib/aigc-hub/minio-backups', 'Existing MinIO PV path differs'
    assert spec.get('persistentVolumeReclaimPolicy') == 'Retain', 'MinIO PV must retain data'
    assert spec.get('capacity', {}).get('storage') == '100Gi', 'Existing MinIO PV capacity differs'
    assert spec.get('claimRef', {}).get('namespace', 'bosch-aigc-dsh') == 'bosch-aigc-dsh', 'MinIO PV belongs to another namespace'
    assert spec.get('claimRef', {}).get('name', 'aigc-backup-minio') == 'aigc-backup-minio', 'MinIO PV belongs to another PVC'
    terms = spec.get('nodeAffinity', {}).get('required', {}).get('nodeSelectorTerms', [])
    assert terms == [{'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': ['bosch-k8s-node-nj304']}]}], 'Unexpected MinIO PV node affinity'
pvc = read('pvc')
if pvc:
    assert pvc['spec'].get('volumeName') == 'aigc-backup-minio', 'MinIO PVC uses another PV'
    assert pvc.get('status', {}).get('phase') == 'Bound', 'Existing MinIO PVC is not Bound'
deployment = read('deployment')
if deployment:
    spec = deployment['spec']['template']['spec']
    assert spec.get('nodeSelector', {}).get('kubernetes.io/hostname') == 'bosch-k8s-node-nj304', 'MinIO uses another node'
    container = next(c for c in spec['containers'] if c['name'] == 'minio')
    assert container.get('args') == ['server', '/data', '--console-address', ':9001'], 'Unexpected MinIO command'
    assert any(v.get('persistentVolumeClaim', {}).get('claimName') == 'aigc-backup-minio' for v in spec.get('volumes', [])), 'MinIO must use expected PVC'
service = read('service')
if service:
    assert service['spec'].get('type', 'ClusterIP') == 'ClusterIP', 'Existing MinIO service must remain internal'
secret = read('secret')
if secret:
    for key in ['root-user', 'root-password', 'access-key', 'secret-key']:
        value = base64.b64decode(secret.get('data', {}).get(key, ''), validate=True).decode()
        assert value, 'Existing MinIO secret missing key: ' + key
elif pv or pvc or deployment:
    raise ValueError('Existing MinIO resources without credentials; restore the original Secret before proceeding')
if '--create-secret' in sys.argv and not secret:
    secret = {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'aigc-backup-minio', 'namespace': 'bosch-aigc-dsh'}, 'type': 'Opaque', 'stringData': {
        'root-user': os.environ.get('MINIO_ROOT_USER', 'admin'),
        'root-password': os.environ.get('MINIO_ROOT_PASSWORD', 'admin@1234'),
        'access-key': 'dsh-backup-' + secrets.token_hex(6),
        'secret-key': secrets.token_urlsafe(32)}}
    path = root / 'minio-new-secret.json'
    path.write_text(json.dumps(secret))
    path.chmod(0o600)
print('MinIO resource checks passed; existing credentials will be retained.')
