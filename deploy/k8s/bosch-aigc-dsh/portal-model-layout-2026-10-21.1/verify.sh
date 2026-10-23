#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
base=${PORTAL_BASE_URL:-https://aigcplatform.boschhuayu-steering.com}
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" get deployment aigc-portal -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = next(c for c in d["spec"]["template"]["spec"]["containers"] if c["name"] == "portal")
assert c["image"].split("/")[-1] == "aigc-portal:2026-10-21-model-layout.1", "Unexpected Portal image"
assert d["status"].get("observedGeneration", 0) >= d["metadata"]["generation"], "New generation is not observed"
n = d["spec"].get("replicas", 1)
assert n > 0 and d["status"].get("updatedReplicas", 0) == n and d["status"].get("availableReplicas", 0) >= n, "New Portal replicas are not ready"
print("New Portal image and replicas verified")
'
for path in /login/local /desktop; do
  curl --fail --silent --show-error --retry 3 --connect-timeout 10 --max-time 30 "$base$path" -o /dev/null
  echo "HTTPS page passed: $path"
done
