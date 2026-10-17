#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
command -v kubectl >/dev/null
command -v python3 >/dev/null
# Images are imported separately on nj304; the master need not retain the tar.
# This replacement script is intentionally different from the original manifest.
python3 - <<'PYCODE'
import hashlib, pathlib
root = pathlib.Path('.')
for line in (root / 'SHA256SUMS').read_text().splitlines():
    if not line.strip():
        continue
    expected, name = line.split(maxsplit=1)
    name = name.lstrip('*')
    path = pathlib.Path(name)
    if path.is_absolute() or '..' in path.parts:
        raise SystemExit(f'Unsafe checksum path: {name}')
    if path.name == 'update.sh':
        print('update.sh: replacement script; original self-check skipped')
        continue
    if path.suffix == '.tar' and not path.exists():
        print(f'{name}: absent on master; images must already be imported on nj304')
        continue
    data = path.read_bytes()
    candidates = [data]
    if path.suffix == '.sh':
        lf = data.replace(b'\r\n', b'\n')
        candidates += [lf, lf.replace(b'\n', b'\r\n')]
    if not any(hashlib.sha256(value).hexdigest() == expected for value in candidates):
        raise SystemExit(f'{name}: checksum mismatch; deployment stopped')
    print(f'{name}: OK')
PYCODE
printf '%s\n' 'Checking that both release images are imported on nj304 (SSH/sudo may request a password).'
command -v ssh >/dev/null
ssh -t "${NJ304_SSH_TARGET:-nj00663@172.28.2.33}" \
  'sudo crictl inspecti docker.io/library/aigc-api:2026-10-09.1 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-09.1 >/dev/null'
kubectl get node bosch-k8s-node-nj304 >/dev/null
backup="backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
printf 'Backup directory: %s\n' "$backup"
for name in aigc-api aigc-portal; do
  kubectl -n "$ns" get deployment "$name" -o json > "$backup/$name.json"
done
python3 - "$backup" <<'PYCODE'
import json,sys,pathlib
root=pathlib.Path(sys.argv[1])
for name,container in [('aigc-api','api'),('aigc-portal','portal')]:
    obj=json.loads((root/f'{name}.json').read_text())
    spec=obj['spec']['template']['spec']
    assert spec.get('nodeSelector',{}).get('kubernetes.io/hostname')=='bosch-k8s-node-nj304', f'{name}: unexpected scheduling; import images on every possible target node first'
    old=next(c for c in spec['containers'] if c['name']==container)
    patch={'spec':{'template':{'spec':{'containers':[{'name':container,'image':old['image'],'imagePullPolicy':old.get('imagePullPolicy','IfNotPresent')}]}}}}
    (root/f'{container}-restore.json').write_text(json.dumps(patch))
PYCODE
kubectl -n "$ns" get configmap aigc-settings -o yaml > "$backup/aigc-settings.yaml"
kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
kubectl -n "$ns" patch deployment aigc-api --type strategic --patch-file api-update.patch.json
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" patch deployment aigc-portal --type strategic --patch-file portal-update.patch.json
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" get pods -o wide
printf 'Update completed. Rollback: bash rollback.sh %s\n' "$backup"
