"""Reuse the live-manifest-aware release checks, then add MinIO configuration."""
import json
import pathlib
import runpy
import sys

runpy.run_path(str(pathlib.Path(__file__).with_name('base_prepare.py')), run_name='__main__')
root = pathlib.Path(sys.argv[1])
obj = json.loads((root / 'aigc-api.json').read_text())
spec = obj['spec']['template']['spec']
assert obj['spec'].get('replicas', 1) == 1, 'Backup quota/cleanup currently requires one API replica'
index, container = next((i,c) for i,c in enumerate(spec['containers']) if c['name'] == 'api')
prefix = f'/spec/template/spec/containers/{index}/env'
env = container.get('env', [])
additions = {
    'BackupStorage__Enabled': {'value': 'true'},
    'BackupStorage__Endpoint': {'value': 'http://aigc-backup-minio:9000'},
    'BackupStorage__Bucket': {'value': 'dsh-backups'},
    'BackupStorage__MaximumBytes': {'value': '1073741824'},
    'BackupStorage__AccountQuotaBytes': {'value': '10737418240'},
    'BackupStorage__PartBytes': {'value': '8388608'},
    'BackupStorage__UploadLifetimeHours': {'value': '168'},
    'BackupStorage__AccessKey': {'valueFrom': {'secretKeyRef': {'name': 'aigc-backup-minio', 'key': 'access-key'}}},
    'BackupStorage__SecretKey': {'valueFrom': {'secretKeyRef': {'name': 'aigc-backup-minio', 'key': 'secret-key'}}},
}
settings = json.loads((root / 'aigc-settings.json').read_text()).get('data', {})
# Refuse an unnoticed switch away from a previously configured object store.
for key in ['BackupStorage__Endpoint', 'BackupStorage__Bucket']:
    old = next((e.get('value') for e in env if e['name'] == key), settings.get(key))
    assert old in (None, '', additions[key]['value']), f'{key}: existing object store differs; migrate before switching'
new_env = [e for e in env if e['name'] not in additions] + [{'name': k, **v} for k,v in additions.items()]
for suffix in ['apply', 'restore']:
    path = root / f'api-{suffix}.json'
    patch = json.loads(path.read_text())
    if suffix == 'apply':
        patch.append({'op': 'add', 'path': prefix, 'value': new_env})
    else:
        patch.append({'op': 'add', 'path': prefix, 'value': env} if 'env' in container else {'op': 'remove', 'path': prefix})
    path.write_text(json.dumps(patch))
print('API image and MinIO env patches prepared; previous env preserved for rollback.')
