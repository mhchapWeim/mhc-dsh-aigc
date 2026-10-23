#!/usr/bin/env bash
# Run on DMZ: sudo bash deploy-dmz-asr.sh
set -euo pipefail
umask 077
CONTAINER=litellm-gateway
CONF=/home/admnj00663/litellm/nginx.conf
CHECK_ONLY=${CHECK_ONLY:-0}
test "$(id -u)" -eq 0 || { echo 'Run with sudo bash deploy-dmz-asr.sh' >&2; exit 1; }
for tool in docker python3 flock cmp; do command -v "$tool" >/dev/null; done
exec 9>"${CONF}.asr.lock"
flock -n 9 || { echo 'Another ASR update is running' >&2; exit 1; }
test -f "$CONF"
test "$(docker inspect "$CONTAINER" --format '{{.HostConfig.NetworkMode}}')" = host
test "$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/nginx.conf"}}{{.Source}}{{end}}{{end}}')" = "$CONF"
docker exec "$CONTAINER" nginx -t
docker exec "$CONTAINER" test -r /etc/ssl/certs/ca-certificates.crt
TMP=$(mktemp -d)
REMOTE="/tmp/asr-check-$(date +%s)-$$.conf"
PENDING=0
BACKUP=''
cleanup() {
    code=$?
    trap - EXIT
    if [ "$PENDING" = 1 ]; then
        echo "Restoring previous configuration: $BACKUP" >&2
        if cat "$BACKUP" > "$CONF" && docker exec "$CONTAINER" nginx -t && docker exec "$CONTAINER" nginx -s reload; then
            echo 'Previous configuration restored' >&2
        else
            echo "Automatic restore failed; inspect $CONF and $BACKUP immediately" >&2
        fi
        code=1
    fi
    docker exec "$CONTAINER" rm -f "$REMOTE" >/dev/null 2>&1 || true
    rm -f "$TMP/candidate.conf" "$TMP/original.conf"
    rmdir "$TMP" 2>/dev/null || true
    exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -p "$CONF" "$TMP/original.conf"
python3 - "$TMP/original.conf" "$TMP/candidate.conf" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text()
def end_block(start):
    depth, quote, comment, escaped = 0, None, False, False
    for i in range(text.index('{', start), len(text)):
        c = text[i]
        if comment:
            if c == '\n': comment = False
            continue
        if quote:
            if escaped: escaped = False
            elif c == '\\': escaped = True
            elif c == quote: quote = None
            continue
        if c == '#': comment = True
        elif c in ('"', "'"): quote = c
        elif c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: return i + 1
    raise SystemExit('Unbalanced configuration; no changes made')

servers = []
for m in re.finditer(r'(?m)^[ \t]*server\s*\{', text):
    end = end_block(m.start())
    block = text[m.start():end]
    if re.search(r'(?m)^\s*server_name\s+litellm\.boschhuayu-steering\.com\s*;', block):
        servers.append((m.start(), end, block))
if len(servers) != 1:
    raise SystemExit('Expected exactly one DMZ server; no changes made')
start, end, server = servers[0]
if '/api-ws/' in server:
    raise SystemExit('ASR route already present; inspect existing configuration; no changes made')
anchors = list(re.finditer(r'(?m)^([ \t]*)location\s*=\s*/__aigc/bocha-search\s*\{', server))
if len(anchors) != 1:
    raise SystemExit('Expected one Bocha route as insertion anchor; no changes made')
anchor = anchors[0]
position = start + anchor.start()
bocha = text[position:end_block(position)]
acl = re.findall(r'(?m)^\s*(allow|deny)\s+([^;\n]+);\s*(?:#.*)?$', bocha)
if not acl or acl[-1] != ('deny', 'all') or not any(a == 'allow' and v != 'all' for a,v in acl) or ('allow','all') in acl:
    raise SystemExit('Bocha source allowlist not recognized; no changes made')
lines = '''location = /api-ws/v1/inference {
    # Reuse the existing Bocha network source restrictions.
ACL
    resolver 127.0.0.53 valid=30s ipv6=off;
    resolver_timeout 5s;
    set $asr_host ws-ho4ojmbqyhvmtbay.cn-beijing.maas.aliyuncs.com;
    proxy_pass https://$asr_host/api-ws/v1/inference;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $asr_host;
    proxy_ssl_server_name on;
    proxy_ssl_name $asr_host;
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    proxy_ssl_verify_depth 3;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    proxy_connect_timeout 10s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_next_upstream off;
}
'''.replace('ACL', '\n'.join('    '+a+' '+v+';' for a,v in acl))
snippet = '\n'.join(anchor[1] + line for line in lines.splitlines()) + '\n'
Path(sys.argv[2]).write_text(text[:position] + snippet + text[position:])
print('Prepared ASR location; copied existing Bocha source restrictions')
PY
docker exec -i "$CONTAINER" sh -c 'cat > "$1"' sh "$REMOTE" < "$TMP/candidate.conf"
docker exec "$CONTAINER" nginx -t -c "$REMOTE"
if [ "$CHECK_ONLY" = 1 ]; then
    echo 'CHECK_ONLY passed; live configuration unchanged'
    exit 0
fi
cmp -s "$CONF" "$TMP/original.conf" || { echo 'Configuration changed concurrently; stopped' >&2; exit 1; }
BACKUP="${CONF}.before-asr-$(date +%Y%m%d-%H%M%S)-$$"
cp -p "$CONF" "$BACKUP"
echo "Backup: $BACKUP"
PENDING=1
# Preserve the inode for the existing read-only single-file bind mount.
cat "$TMP/candidate.conf" > "$CONF"
docker exec "$CONTAINER" cat /etc/nginx/nginx.conf | cmp -s - "$TMP/candidate.conf"
docker exec "$CONTAINER" nginx -t
docker exec "$CONTAINER" nginx -s reload
PENDING=0
echo 'DMZ ASR route installed; real WebSocket/ASR acceptance still required'
echo "Backup retained: $BACKUP"
