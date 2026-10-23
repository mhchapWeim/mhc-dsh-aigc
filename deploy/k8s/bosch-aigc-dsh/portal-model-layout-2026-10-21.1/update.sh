#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
target=${NJ304_SSH_TARGET:-nj00663@172.28.2.33}
sha256sum -c SHA256SUMS
for tool in kubectl python3 ssh; do command -v "$tool" >/dev/null; done
backup="backup-$(date +%Y%m%d-%H%M%S)-$$"
mkdir "$backup"
kubectl -n "$ns" get deployment aigc-portal -o json > "$backup/aigc-portal.json"
python3 prepare.py "$backup"
ssh -t "$target" 'sudo crictl inspecti docker.io/library/aigc-portal:2026-10-21-model-layout.1 >/dev/null'
kubectl -n "$ns" patch deployment aigc-portal --type json --patch-file "$backup/apply.json" --dry-run=server >/dev/null
if [[ ${CHECK_ONLY:-0} == 1 ]]; then
  echo "CHECK_ONLY passed; no Deployment was changed. Snapshot: $backup"
  exit 0
fi
printf '%s\n' "$backup" > LAST_BACKUP
echo "Updating Portal only. Rollback: bash rollback.sh $backup"
kubectl -n "$ns" patch deployment aigc-portal --type json --patch-file "$backup/apply.json"
bash verify.sh
echo "Portal rollout and public page checks passed. Validate model details after signing in."
