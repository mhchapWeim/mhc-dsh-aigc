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
echo '[1/7] Checking node-local images and current workloads'
ssh -t "$target" 'sudo crictl inspecti docker.io/library/aigc-api:2026-10-21-minio.1 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-21-minio.1 >/dev/null && sudo crictl inspecti docker.io/library/aigc-backup-minio:2025-06-13-offline.1 >/dev/null'
backup=$(mktemp -d backup-$(date +%Y%m%d-%H%M%S)-XXXXXX)
echo "Private snapshot directory: $backup"
for name in aigc-api aigc-portal; do
  kubectl -n "$ns" get deployment "$name" -o json > "$backup/$name.json"
  kubectl -n "$ns" rollout status deployment/"$name" --timeout=60s
done
kubectl -n "$ns" get configmap aigc-settings -o json > "$backup/aigc-settings.json"
kubectl -n "$ns" get secret aigc-secrets -o json > "$backup/aigc-secrets.json"
kubectl get pv aigc-backup-minio --ignore-not-found -o json > "$backup/minio-pv.json"
for kind in pvc deployment service secret; do
  kubectl -n "$ns" get "$kind" aigc-backup-minio --ignore-not-found -o json > "$backup/minio-$kind.json"
done
python3 prepare.py "$backup"
python3 minio_prepare.py "$backup"
job="aigc-backup-init-$(date +%s)-${RANDOM}"
python3 - "$job" "$backup/bootstrap.yaml" <<'PY'
import pathlib,sys
text=pathlib.Path('minio/bootstrap.yaml').read_text()
text=text.replace('name: aigc-backup-minio-bootstrap', 'name: '+sys.argv[1])
pathlib.Path(sys.argv[2]).write_text(text)
PY
for name in api portal; do
  kubectl -n "$ns" patch deployment "aigc-$name" --type json --patch-file "$backup/$name-apply.json" --dry-run=server -o name
done
for file in minio/pv.yaml minio/minio.yaml "$backup/bootstrap.yaml"; do kubectl apply --dry-run=server -f "$file" -o name; done
if [[ ${CHECK_ONLY:-0} == 1 ]]; then
  echo "Checks passed. Snapshot: $backup. No cluster or node changes made."
  exit 0
fi
printf '%s\n' "$backup" > LAST_BACKUP
trap 'echo "Update stopped. Inspect cluster; backup: $backup. Rollback: bash rollback.sh $backup" >&2' ERR
echo '[2/7] Database backup policy: no schema migration in this release'
if [[ ${BACKUP_DATABASE:-0} == 1 ]]; then
  echo 'Creating optional database dump (timeout 300s)'
  timeout 300 kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
  test -s "$backup/database.dump"
  echo "Database dump complete: $(wc -c < "$backup/database.dump") bytes"
else
  echo 'Database dump skipped. Set BACKUP_DATABASE=1 to request one; configuration snapshots are always retained.'
fi
echo '[3/7] Preparing persistent MinIO directory and Secret'
ssh -t "$target" 'sudo install -d -m 0750 /var/lib/aigc-hub/minio-backups'
python3 minio_prepare.py "$backup" --create-secret
if [[ -f "$backup/minio-new-secret.json" ]]; then
  kubectl create -f "$backup/minio-new-secret.json"
fi
echo '[4/7] Starting K8s MinIO; retaining existing PV/PVC and credentials'
if [[ ! -s "$backup/minio-pv.json" ]]; then kubectl create -f minio/pv.yaml; fi
kubectl apply -f minio/minio.yaml
kubectl -n "$ns" wait pvc/aigc-backup-minio --for=jsonpath='{.status.phase}'=Bound --timeout=180s
kubectl -n "$ns" rollout status deployment/aigc-backup-minio --timeout=300s
# Unique Job name makes initialization repeatable without deleting an existing Job.
kubectl apply -f "$backup/bootstrap.yaml"
kubectl -n "$ns" wait --for=condition=complete "job/$job" --timeout=300s
printf '%s\n' "$job" > "$backup/bootstrap-job"
echo '[5/7] Updating API image and enabling MinIO backup configuration'
kubectl -n "$ns" patch deployment aigc-api --type json --patch-file "$backup/api-apply.json"
touch "$backup/api-applied"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
echo '[6/7] Updating Portal image'
kubectl -n "$ns" patch deployment aigc-portal --type json --patch-file "$backup/portal-apply.json"
touch "$backup/portal-applied"
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
echo '[7/7] Verifying images, MinIO, HTTPS and pages'
bash verify.sh "$backup"
echo "Update checks passed. Snapshot: $backup. Complete DSH upload/resume/restore and browser SSO acceptance."
