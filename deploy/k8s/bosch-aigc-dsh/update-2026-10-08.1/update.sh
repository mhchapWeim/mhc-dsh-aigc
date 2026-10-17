#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
command -v kubectl >/dev/null
command -v python3 >/dev/null
kubectl -n "$ns" get deployment aigc-api aigc-portal aigc-edge aigc-postgres >/dev/null
kubectl -n "$ns" get pvc aigc-dsh-uploads -o json | python3 -c 'import json,sys; p=json.load(sys.stdin); assert p["status"]["phase"]=="Bound", "uploads PVC must be Bound"'
# Refuse an unexpected storage layout instead of replacing an existing claim.
kubectl -n "$ns" get deployment aigc-api -o json | python3 -c 'import json,sys; p=json.load(sys.stdin); assert any(v["name"]=="uploads" and v.get("persistentVolumeClaim",{}).get("claimName")=="aigc-dsh-uploads" for v in p["spec"]["template"]["spec"]["volumes"]), "unexpected API uploads volume"'
backup="backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
kubectl -n "$ns" get deployment aigc-api aigc-portal aigc-edge -o yaml > "$backup/deployments.yaml"
kubectl -n "$ns" get configmap aigc-edge-nginx -o json > "$backup/edge-config.json"
kubectl -n "$ns" get deployment aigc-api -o jsonpath='{.spec.template.spec.containers[?(@.name=="api")].image}' > "$backup/api-image.txt"
kubectl -n "$ns" get deployment aigc-portal -o jsonpath='{.spec.template.spec.containers[?(@.name=="portal")].image}' > "$backup/portal-image.txt"
# The PostgreSQL container supplies its own credentials; never echo secrets.
kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
# Preserve every other live Nginx directive, including the existing static pilot feed.
python3 - "$backup/edge-config.json" > "$backup/edge-patch.json" <<'PY'
import json,re,sys
config=json.load(open(sys.argv[1]))["data"]["default.conf"]
assert re.search(r"client_max_body_size\s+[^;]+;",config), "missing upload limit directive"
config=re.sub(r"client_max_body_size\s+[^;]+;", "client_max_body_size 2100m;",config)
print(json.dumps({"data":{"default.conf":config}}))
PY
kubectl -n "$ns" patch deployment aigc-api --type strategic --patch-file api-update.patch.json
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" set image deployment/aigc-portal portal=aigc-portal:2026-10-08.1
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" patch configmap aigc-edge-nginx --type merge --patch-file "$backup/edge-patch.json"
kubectl -n "$ns" rollout restart deployment/aigc-edge
kubectl -n "$ns" rollout status deployment/aigc-edge --timeout=180s
kubectl -n "$ns" exec deployment/aigc-edge -- nginx -t
kubectl -n "$ns" get pods -o wide
printf 'Update completed. Backup directory: %s\n' "$backup"
