#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
backup=${1:-$(cat LAST_BACKUP)}
test -f "$backup/rollback.json"
kubectl -n bosch-aigc-dsh patch deployment aigc-portal --type json --patch-file "$backup/rollback.json"
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-portal --timeout=300s
echo 'Previous Portal image restored. API and data were not changed.'
