#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
backup=${1:?Usage: bash rollback.sh backup-YYYYMMDD-HHMMSS}
ns=bosch-aigc-dsh
test -s "$backup/switch-state.json"
echo 'Restore the saved configuration only if no later operator changes need to be retained.'
for name in aigc-settings aigc-edge-nginx nj304-litellm-proxy; do
  kubectl -n "$ns" patch configmap "$name" --type json --patch-file "$backup/$name-restore.json"
done
for name in aigc-api aigc-portal aigc-edge nj304-litellm-proxy; do
  kubectl -n "$ns" patch deployment "$name" --type strategic --patch-file "$backup/$name-deployment-restore.json"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=300s
done
# Recreate any Pods whose mounted ConfigMap changed but Pod template was unchanged.
for name in aigc-api aigc-edge nj304-litellm-proxy; do
  kubectl -n "$ns" rollout restart deployment/"$name"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=300s
done
# Old Secret was never replaced. Restore a pre-existing new Secret if one existed.
if [[ -s "$backup/platform-secret-before.json" ]]; then
  python3 - "$backup" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]); obj=json.loads((p/'platform-secret-before.json').read_text())
(p/'platform-secret-restore.json').write_text(json.dumps([{'op':'replace','path':'/data','value':obj['data']}]))
PY
  kubectl -n "$ns" patch secret aigc-platform-tls --type json --patch-file "$backup/platform-secret-restore.json"
fi
echo 'Rollback completed. Database/PVCs retained. A newly created unreferenced platform TLS Secret is retained for inspection.'
