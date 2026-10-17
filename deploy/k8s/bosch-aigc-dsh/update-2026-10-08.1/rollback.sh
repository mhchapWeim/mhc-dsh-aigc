#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backup=${1:?Usage: bash rollback.sh backup-YYYYMMDD-HHMMSS}
ns=bosch-aigc-dsh
python3 - "$backup/edge-config.json" > "$backup/edge-restore.json" <<'PY'
import json,sys
print(json.dumps({"data":json.load(open(sys.argv[1]))["data"]}))
PY
kubectl -n "$ns" set image deployment/aigc-api "api=$(cat "$backup/api-image.txt")"
kubectl -n "$ns" set image deployment/aigc-portal "portal=$(cat "$backup/portal-image.txt")"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" patch configmap aigc-edge-nginx --type merge --patch-file "$backup/edge-restore.json"
kubectl -n "$ns" rollout restart deployment/aigc-edge
kubectl -n "$ns" rollout status deployment/aigc-edge --timeout=180s
# Keep additive database tables and uploaded installers. Do not restore the database over new user data.
