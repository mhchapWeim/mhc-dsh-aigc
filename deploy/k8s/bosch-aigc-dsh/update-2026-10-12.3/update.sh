#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
command -v kubectl >/dev/null
command -v python3 >/dev/null
command -v ssh >/dev/null
# The image archive may remain on nj304 after it has been imported.
python3 - <<'PY'
import hashlib,pathlib
for line in pathlib.Path('SHA256SUMS').read_text().splitlines():
    expected,name=line.split(maxsplit=1)
    path=pathlib.Path(name)
    if path.is_absolute() or '..' in path.parts: raise SystemExit('Unsafe checksum path')
    if path.suffix=='.tar' and not path.exists(): continue
    with path.open('rb') as source: actual=hashlib.file_digest(source,'sha256').hexdigest()
    if actual!=expected: raise SystemExit(f'{name}: checksum mismatch')
PY
ssh -t "${NJ304_SSH_TARGET:-nj00663@172.28.2.33}" \
  'sudo crictl inspecti docker.io/library/aigc-api:2026-10-12.3 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-12.3 >/dev/null'
kubectl get node bosch-k8s-node-nj304 >/dev/null
backup="backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
printf 'Backup directory: %s\n' "$backup"
for name in aigc-api aigc-portal; do
  kubectl -n "$ns" get deployment "$name" -o json > "$backup/$name.json"
done
kubectl -n "$ns" get configmap aigc-settings -o json > "$backup/aigc-settings.json"
python3 - "$backup" <<'PY'
import json,sys,pathlib
root=pathlib.Path(sys.argv[1])
settings=json.loads((root/'aigc-settings.json').read_text()).get('data',{})
for name,container in [('aigc-api','api'),('aigc-portal','portal')]:
    obj=json.loads((root/f'{name}.json').read_text())
    spec=obj['spec']['template']['spec']
    if spec.get('nodeSelector',{}).get('kubernetes.io/hostname')!='bosch-k8s-node-nj304':
        raise SystemExit(f'{name}: unexpected scheduling; import images on every possible target node first')
    old=next(c for c in spec['containers'] if c['name']==container)
    restore={'name':container,'image':old['image'],'imagePullPolicy':old.get('imagePullPolicy','IfNotPresent')}
    patch=json.loads(pathlib.Path(f'{container}-update.patch.json').read_text())
    if container=='api':
        # Preserve explicit settings; introduce persistent defaults only when absent.
        restore['env']=[{'$patch':'replace'},*old.get('env',[])]
        entries={e['name']:e for e in old.get('env',[])}
        mounts=old.get('volumeMounts',[])
        volumes={v['name']:v for v in spec.get('volumes',[])}
        additions=[]
        for key,folder in [('Plugins__StoragePath','managed-plugins'),('DesktopReleases__Root','desktop-releases')]:
            entry=entries.get(key)
            if entry and 'valueFrom' in entry: raise SystemExit(f'{key}: resolve valueFrom and verify persistent storage before updating')
            path=(entry or {}).get('value') or settings.get(key)
            if not path:
                path='/var/lib/aigc-hub/dsh-uploads/'+folder
                additions.append({'name':key,'value':path})
            persistent=any(not m.get('readOnly',False) and
                (path==m['mountPath'] or path.startswith(m['mountPath'].rstrip('/')+'/')) and
                'persistentVolumeClaim' in volumes.get(m['name'],{}) for m in mounts)
            if not persistent: raise SystemExit(f'{key}: {path} must be backed by an existing writable PVC; update stopped')
        if additions: patch['spec']['template']['spec']['containers'][0]['env']=additions
    (root/f'{container}-restore.json').write_text(json.dumps({'spec':{'template':{'spec':{'containers':[restore]}}}}))
    (root/f'{container}-apply.json').write_text(json.dumps(patch))
PY
kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
# Retain packages from an older container's default path before replacing it.
# Existing configured storage is preserved by the preflight above.
kubectl -n "$ns" exec deployment/aigc-api -- sh -c '
  if [ -d /app/App_Data/plugins ]; then
    mkdir -p /var/lib/aigc-hub/dsh-uploads/managed-plugins
    cp -an /app/App_Data/plugins/. /var/lib/aigc-hub/dsh-uploads/managed-plugins/
  fi
  if [ -d /app/data/desktop-releases ]; then
    mkdir -p /var/lib/aigc-hub/dsh-uploads/desktop-releases
    cp -an /app/data/desktop-releases/. /var/lib/aigc-hub/dsh-uploads/desktop-releases/
  fi
'
kubectl -n "$ns" patch deployment aigc-api --type strategic --patch-file "$backup/api-apply.json"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" patch deployment aigc-portal --type strategic --patch-file "$backup/portal-apply.json"
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" get pods -o wide
printf '%s\n' "$backup" > LAST_BACKUP
printf 'Update completed. Rollback: bash rollback.sh %s\n' "$backup"
