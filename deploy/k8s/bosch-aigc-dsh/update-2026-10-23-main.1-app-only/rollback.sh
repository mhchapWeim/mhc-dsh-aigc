#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
backup=${1:?Usage: bash rollback.sh backup-directory}
ns=bosch-aigc-dsh
exec 9>.update.lock
flock -n 9 || { echo 'Another update is running' >&2; exit 1; }
for name in portal api; do
  test -f "$backup/$name-restore.json"
  current=$(kubectl -n "$ns" get deployment "aigc-$name" -o json)
  action=$(printf '%s' "$current" | python3 -c 'import json,sys; obj=json.load(sys.stdin); state=json.load(open(sys.argv[1]))[sys.argv[2]]; c=next(c for c in obj["spec"]["template"]["spec"]["containers"] if c["name"]==sys.argv[2]); image=c["image"]; assert image in (state["oldImage"],state["newImage"]), "Image changed externally; inspect before rollback"; print("skip" if image==state["oldImage"] else "restore")' "$backup/images.json" "$name")
  if [[ "$action" == restore ]]; then
    kubectl -n "$ns" patch deployment "aigc-$name" --type json --patch-file "$backup/$name-restore.json"
  fi
  kubectl -n "$ns" rollout status deployment/"aigc-$name" --timeout=300s
done
echo 'Original API/Portal images and pull policies restored. Complete business checks.'
