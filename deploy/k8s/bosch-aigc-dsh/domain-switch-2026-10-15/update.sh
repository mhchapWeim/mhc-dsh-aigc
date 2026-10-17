#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
target=${NJ304_SSH_TARGET:-nj00663@172.28.2.33}
for command in kubectl python3 openssl curl ssh sha256sum; do command -v "$command" >/dev/null; done
sha256sum -c SHA256SUMS
openssl x509 -in tls/fullchain.crt -noout -checkend 604800 >/dev/null
openssl x509 -in tls/fullchain.crt -noout -checkhost aigcplatform.boschhuayu-steering.com | grep -F 'does match' >/dev/null
cert_public=$(openssl x509 -in tls/fullchain.crt -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_public=$(openssl pkey -in tls/tls.key -passin pass: -pubout -outform DER | sha256sum)
test "$cert_public" = "$key_public"
if [[ ${CHECK_ONLY:-0} != 1 && ${CAS_READY:-0} != 1 ]]; then
  echo 'Confirm enterprise CAS allows the new callback including portal_state; then run CAS_READY=1 bash update.sh.' >&2
  exit 1
fi
ssh -t "$target" 'sudo crictl inspecti docker.io/library/aigc-api:2026-10-15-domain.1 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-15-domain.1 >/dev/null'
backup="backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
for name in aigc-api aigc-portal aigc-edge nj304-litellm-proxy; do
  kubectl -n "$ns" get deployment "$name" -o json > "$backup/$name-deployment.json"
done
for name in aigc-settings aigc-edge-nginx nj304-litellm-proxy; do
  kubectl -n "$ns" get configmap "$name" -o json > "$backup/$name.json"
done
kubectl -n "$ns" get secret aigc-secrets -o json > "$backup/aigc-secrets.json"
kubectl -n "$ns" get secret aigc-edge-tls -o json > "$backup/aigc-edge-tls.json"
python3 prepare.py "$backup"
check_nginx() {
  kubectl -n "$ns" exec -i deployment/"$1" -c nginx -- sh -eu -c '
    candidate=$(mktemp /tmp/aigc-nginx-check.XXXXXX)
    trap "rm -f \"$candidate\"" 0
    cat > "$candidate"
    nginx -t -c "$candidate"
  ' < "$2"
}
# nginx reads its configuration again after parsing; stdin cannot be rewound.
check_nginx aigc-edge "$backup/aigc-edge-nginx-check.conf"
check_nginx nj304-litellm-proxy "$backup/nj304-litellm-proxy-check.conf"
if [[ ${CHECK_ONLY:-0} == 1 ]]; then
  echo "CHECK ONLY passed. Protected snapshots: $backup. No cluster writes."
  exit 0
fi
kubectl -n "$ns" get secret aigc-platform-tls --ignore-not-found -o json > "$backup/platform-secret-before.json"
kubectl -n "$ns" create secret tls aigc-platform-tls --cert=tls/fullchain.crt --key=tls/tls.key --dry-run=client -o json > "$backup/platform-secret-apply.json"
kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
printf '%s\n' "$backup" > LAST_BACKUP
trap 'echo "Update stopped; inspect protected backup and run: bash rollback.sh $backup" >&2' ERR
kubectl apply -f "$backup/platform-secret-apply.json"
for name in aigc-edge-nginx nj304-litellm-proxy; do
  kubectl -n "$ns" patch configmap "$name" --type merge --patch-file "$backup/$name-apply.json"
done
for name in aigc-edge nj304-litellm-proxy; do
  kubectl -n "$ns" patch deployment "$name" --type strategic --patch-file "$backup/$name-deployment-apply.json"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=300s
  kubectl -n "$ns" exec deployment/"$name" -c nginx -- nginx -t
done
kubectl -n "$ns" patch configmap aigc-settings --type merge --patch-file "$backup/settings-apply.json"
for name in aigc-api aigc-portal; do
  kubectl -n "$ns" patch deployment "$name" --type strategic --patch-file "$backup/$name-deployment-apply.json"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=300s
done
bash verify.sh "$backup"
echo "Update finished. Backup: $backup. Browser SSO and old/new DSH acceptance remain required."
