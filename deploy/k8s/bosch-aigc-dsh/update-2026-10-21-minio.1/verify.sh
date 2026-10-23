#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backup=${1:-$(cat LAST_BACKUP)}
ns=bosch-aigc-dsh
for name in api portal; do
  kubectl -n "$ns" rollout status deployment/"aigc-$name" --timeout=300s
  kubectl -n "$ns" get deployment "aigc-$name" -o json | python3 -c 'import json,sys; obj=json.load(sys.stdin); state=json.load(open(sys.argv[1])); name=sys.argv[2]; c=next(c for c in obj["spec"]["template"]["spec"]["containers"] if c["name"]==name); assert c["image"]==state[name]["newImage"] and c["imagePullPolicy"]=="Never"' "$backup/images.json" "$name"
done
args=(--fail --silent --show-error --connect-timeout 10 --max-time 60)
if [[ -n ${CA_FILE:-} ]]; then test -s "$CA_FILE"; args+=(--cacert "$CA_FILE"); fi
base=https://aigcplatform.boschhuayu-steering.com
curl "${args[@]}" "$base/health"
curl "${args[@]}" "$base/api/auth/sso/config" | python3 -c 'import json,sys; assert json.load(sys.stdin)["enabled"] is True'
for path in /login/local /desktop; do curl "${args[@]}" -o /dev/null "$base$path"; done
kubectl -n "$ns" exec deployment/aigc-api -c api -- sh -c 'test -d /var/log/aigc-hub && test -w /var/log/aigc-hub'
kubectl -n "$ns" rollout status deployment/aigc-backup-minio --timeout=300s
kubectl -n "$ns" get deployment aigc-backup-minio -o json | python3 -c 'import json,sys; c=next(c for c in json.load(sys.stdin)["spec"]["template"]["spec"]["containers"] if c["name"]=="minio"); assert c["image"]=="docker.io/library/aigc-backup-minio:2025-06-13-offline.1" and c["imagePullPolicy"]=="Never"'
kubectl -n "$ns" exec deployment/aigc-backup-minio -- sh -ec 'mc alias set check http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null; mc stat check/dsh-backups >/dev/null'
if [[ -n ${DSH_ACCESS_TOKEN:-} ]]; then
  # Token is sent through stdin, not a URL or process argument.
  printf 'header = "Authorization: Bearer %s"\n' "$DSH_ACCESS_TOKEN" | curl "${args[@]}" --config - "$base/v1/backup-transfers/limits" | python3 -c 'import json,sys; v=json.load(sys.stdin); assert v["maximumBytes"]==1073741824 and v["partBytes"]==8388608'
else
  echo 'Authenticated backup limits check skipped; verify in DSH or set DSH_ACCESS_TOKEN.'
fi
echo 'Rollouts, images, HTTPS, pages, MinIO bucket and log directory checks passed.'
