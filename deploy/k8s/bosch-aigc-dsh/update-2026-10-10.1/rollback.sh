#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
backup=${1:?Usage: bash rollback.sh backup-YYYYMMDD-HHMMSS}
ns=bosch-aigc-dsh
kubectl -n "$ns" patch deployment aigc-api --type strategic --patch-file "$backup/api-restore.json"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" patch deployment aigc-portal --type strategic --patch-file "$backup/portal-restore.json"
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
# Additive database tables are retained. Never overwrite new data with the old dump.
