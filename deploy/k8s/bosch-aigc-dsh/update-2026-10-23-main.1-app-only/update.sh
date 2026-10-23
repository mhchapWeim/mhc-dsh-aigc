#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
target=${NJ304_SSH_TARGET:-nj00663@172.28.2.33}
for cmd in kubectl python3 ssh sha256sum curl flock timeout; do command -v "$cmd" >/dev/null; done
sha256sum -c SHA256SUMS
exec 9>.update.lock
flock -n 9 || { echo 'Another update is running' >&2; exit 1; }
echo '[1/5] Checking node-local images and current workloads'
ssh -t "$target" 'sudo crictl inspecti docker.io/library/aigc-api:2026-10-23-main.1 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-23-main.1 >/dev/null'
backup=$(mktemp -d backup-$(date +%Y%m%d-%H%M%S)-XXXXXX)
echo "Private snapshot directory: $backup"
for name in aigc-api aigc-portal; do
  kubectl -n "$ns" get deployment "$name" -o json > "$backup/$name.json"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=60s
done
kubectl -n "$ns" get configmap aigc-settings -o json > "$backup/aigc-settings.json"
kubectl -n "$ns" get secret aigc-secrets -o json > "$backup/aigc-secrets.json"
python3 prepare.py "$backup"
for name in api portal; do
  kubectl -n "$ns" patch deployment "aigc-$name" --type json --patch-file "$backup/$name-apply.json" --dry-run=server -o name
done
if [[ ${CHECK_ONLY:-0} == 1 ]]; then
  echo "Checks passed. Snapshot: $backup. No cluster or node changes made."
  exit 0
fi
printf '%s\n' "$backup" > LAST_BACKUP
trap 'echo "Update stopped. Inspect cluster; backup: $backup. Rollback: bash rollback.sh $backup" >&2' ERR
echo '[2/5] Database backup policy: no schema migration in this release'
if [[ ${BACKUP_DATABASE:-0} == 1 ]]; then
  echo 'Creating optional database dump (timeout 300s)'
  timeout 300 kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
  test -s "$backup/database.dump"
  echo "Database dump complete: $(wc -c < "$backup/database.dump") bytes"
else
  echo 'Database dump skipped. Set BACKUP_DATABASE=1 to request one; configuration snapshots are always retained.'
fi
echo '[3/5] Updating API image; retaining existing environment and storage'
kubectl -n "$ns" patch deployment aigc-api --type json --patch-file "$backup/api-apply.json"
touch "$backup/api-applied"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
echo '[4/5] Updating Portal image'
kubectl -n "$ns" patch deployment aigc-portal --type json --patch-file "$backup/portal-apply.json"
touch "$backup/portal-applied"
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
echo '[5/5] Verifying API/Portal images, HTTPS and pages'
bash verify.sh "$backup"
echo "Update checks passed. Snapshot: $backup. Complete DSH upload/resume/restore and browser SSO acceptance."
