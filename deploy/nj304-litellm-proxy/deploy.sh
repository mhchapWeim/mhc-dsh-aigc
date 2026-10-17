#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -gt 1 ]; then
  echo 'Usage: bash deploy.sh [PROXY_HOSTNAME]' >&2
  exit 1
fi
PROXY_HOST="${1:-aigcbackend.boschhuayu-steering.com}"
for f in proxy.yaml image-ref.txt; do
  test -s "$f" || { echo "Missing file: $f" >&2; exit 1; }
done
IMAGE_REF="$(tr -d '\r\n' < image-ref.txt)"
[[ "$IMAGE_REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
[[ "$PROXY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid proxy hostname' >&2; exit 1; }
kubectl get node bosch-k8s-node-nj304
kubectl get namespace bosch-aigc-dsh
TLS_TYPE="$(kubectl -n bosch-aigc-dsh get secret aigc-edge-tls -o jsonpath='{.type}')"
test "$TLS_TYPE" = 'kubernetes.io/tls' || { echo 'aigc-edge-tls must be a TLS Secret' >&2; exit 1; }
sed "s|image: nginx:stable-alpine|image: ${IMAGE_REF}\n          imagePullPolicy: Never|" proxy.yaml > proxy-rendered.yaml
kubectl apply --dry-run=server -f proxy-rendered.yaml
kubectl apply -f proxy-rendered.yaml
kubectl -n bosch-aigc-dsh rollout restart deployment/nj304-litellm-proxy
kubectl -n bosch-aigc-dsh rollout status deployment/nj304-litellm-proxy --timeout=180s
kubectl -n bosch-aigc-dsh exec deployment/nj304-litellm-proxy -- nginx -t
kubectl -n bosch-aigc-dsh get pods -l app=nj304-litellm-proxy -o wide
echo "Proxy base URL: https://${PROXY_HOST}:30443/v1"
echo 'Validate streaming from the DSH network before changing AIGC.'
