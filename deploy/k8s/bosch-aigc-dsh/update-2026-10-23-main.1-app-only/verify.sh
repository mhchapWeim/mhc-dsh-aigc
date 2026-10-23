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
echo 'API/Portal rollouts, images, HTTPS, pages and log directory checks passed. Complete business acceptance separately.'
