#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
ns=bosch-aigc-dsh
target=${NJ304_SSH_TARGET:-nj00663@172.28.2.33}
sha256sum -c SHA256SUMS --ignore-missing
command -v python3 >/dev/null
ssh -t "$target" 'sudo crictl inspecti docker.io/library/aigc-api:2026-10-14.3 >/dev/null && sudo crictl inspecti docker.io/library/aigc-portal:2026-10-14.3 >/dev/null && sudo install -d -m 0750 /var/lib/aigc-hub/logs'
backup="backup-$(date +%Y%m%d-%H%M%S)"
mkdir "$backup"
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
        raise SystemExit(f'{name}: unexpected target node; stop and inspect scheduling')
    old=next(c for c in spec['containers'] if c['name']==container)
    restore={'name':container,'image':old['image'],'imagePullPolicy':old.get('imagePullPolicy','IfNotPresent')}
    new={'name':container,'image':f'aigc-{container}:2026-10-14.3','imagePullPolicy':'Never'}
    restore_spec={'containers':[restore]}
    apply_spec={'containers':[new]}
    if container=='api':
        mounts=old.get('volumeMounts',[])
        volumes=spec.get('volumes',[])
        volume_by_name={v['name']:v for v in volumes}
        entries={e['name']:e for e in old.get('env',[])}
        additions={
          'Cas__PortalBaseUrl':'https://aigcbackend.boschhuayu-steering.com',
          'FileLogging__Enabled':'true', 'FileLogging__Directory':'/var/log/aigc-hub',
          'FileLogging__MaxFileSizeBytes':'20971520', 'FileLogging__MaxFiles':'50',
          'FileLogging__RetentionDays':'14'}
        for key,folder in [('Plugins__StoragePath','managed-plugins'),('DesktopReleases__Root','desktop-releases')]:
            entry=entries.get(key)
            if entry and 'valueFrom' in entry: raise SystemExit(f'{key}: resolve valueFrom and confirm persistent storage')
            path=(entry or {}).get('value') or settings.get(key)
            if not path:
                path='/var/lib/aigc-hub/dsh-uploads/'+folder
                additions[key]=path
            if not any(not m.get('readOnly',False) and
                (path==m['mountPath'] or path.startswith(m['mountPath'].rstrip('/')+'/')) and
                'persistentVolumeClaim' in volume_by_name.get(m['name'],{}) for m in mounts):
                raise SystemExit(f'{key}: {path} must use an existing writable PVC')
        if 'logs' in volume_by_name and volume_by_name['logs'].get('persistentVolumeClaim',{}).get('claimName')!='aigc-logs':
            raise SystemExit('Existing logs volume has different storage; inspect before changing')
        if any(m['mountPath']=='/var/log/aigc-hub' and m['name']!='logs' for m in mounts):
            raise SystemExit('Log mount path already occupied by another volume')
        restore['env']=[{'$patch':'replace'},*old.get('env',[])]
        restore['volumeMounts']=[{'$patch':'replace'},*mounts]
        restore_spec['volumes']=[{'$patch':'replace'},*volumes]
        new['env']=[{'$patch':'replace'},*[e for e in old.get('env',[]) if e['name'] not in additions],
                    *[{'name':k,'value':v} for k,v in additions.items()]]
        new['volumeMounts']=[{'name':'logs','mountPath':'/var/log/aigc-hub','readOnly':False}]
        apply_spec['volumes']=[{'name':'logs','persistentVolumeClaim':{'claimName':'aigc-logs'}}]
    (root/f'{container}-restore.json').write_text(json.dumps({'spec':{'template':{'spec':restore_spec}}}))
    (root/f'{container}-apply.json').write_text(json.dumps({'spec':{'template':{'spec':apply_spec}}}))
PY
if kubectl get pv bosch-aigc-dsh-logs -o json > "$backup/log-pv.json" 2>/dev/null; then
  python3 - "$backup/log-pv.json" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))['spec']
assert p.get('local',{}).get('path')=='/var/lib/aigc-hub/logs', 'Existing log PV path differs'
assert p.get('persistentVolumeReclaimPolicy')=='Retain', 'Existing log PV must retain data'
PY
fi
kubectl apply -f logging-storage.yaml
kubectl -n "$ns" wait pvc/aigc-logs --for=jsonpath='{.status.phase}'=Bound --timeout=120s
kubectl -n "$ns" exec deployment/aigc-postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/database.dump"
test -s "$backup/database.dump"
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
printf '%s\n' "$backup" > LAST_BACKUP
printf 'Backup: %s; rollback on failure: bash rollback.sh %s\n' "$backup" "$backup"
kubectl -n "$ns" patch deployment aigc-api --type strategic --patch-file "$backup/api-apply.json"
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
kubectl -n "$ns" patch deployment aigc-portal --type strategic --patch-file "$backup/portal-apply.json"
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=300s
kubectl -n "$ns" exec deployment/aigc-api -- sh -c 'test -d /var/log/aigc-hub && test -w /var/log/aigc-hub && ls -lh /var/log/aigc-hub'
kubectl -n "$ns" get pods -o wide
printf 'Update complete; verify SSO and logs using README.md. Backup: %s\n' "$backup"
