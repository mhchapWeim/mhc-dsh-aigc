import base64
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
settings = json.loads((root / 'aigc-settings.json').read_text())['data']
state = {}
for deployment, name in [('aigc-api', 'api'), ('aigc-portal', 'portal')]:
    obj = json.loads((root / (deployment + '.json')).read_text())
    spec = obj['spec']['template']['spec']
    assert spec.get('nodeSelector', {}).get('kubernetes.io/hostname') == 'bosch-k8s-node-nj304', 'Unexpected node selector'
    for init in spec.get('initContainers', []):
        assert deployment == 'aigc-api' and init.get('name') == 'prepare-desktop-releases', 'Unexpected init container'
        assert init.get('image') == 'aigc-api:2026-10-08.1', 'Unexpected init image'
        assert init.get('imagePullPolicy') == 'Never', 'Unexpected init pull policy'
        assert init.get('command') == ['sh', '-c', 'mkdir -p /persist/desktop-releases'], 'Unexpected init command'
        assert not init.get('args'), 'Unexpected init arguments'
        assert init.get('volumeMounts') == [{'mountPath': '/persist', 'name': 'uploads'}], 'Unexpected init mounts'
        assert any(v.get('name') == 'uploads' and v.get('persistentVolumeClaim', {}).get('claimName') == 'aigc-dsh-uploads' for v in spec.get('volumes', [])), 'Unexpected uploads PVC'
    index, container = next((i, c) for i, c in enumerate(spec['containers']) if c['name'] == name)
    image = 'docker.io/library/aigc-' + name + ':2026-10-23-main.1'
    assert container['image'] != image and container['image'] != image.removeprefix('docker.io/library/'), 'Already updated; retain previous backup'
    if name == 'api':
        refs = container.get('envFrom', [])
        effective = {}
        seen = set()
        for source in refs:
            assert not source.get('prefix'), 'Prefixed envFrom requires inspection'
            kind = 'configMapRef' if 'configMapRef' in source else 'secretRef'
            ref = source.get(kind, {})
            source_name = ref.get('name')
            assert (kind, source_name) in [('configMapRef', 'aigc-settings'), ('secretRef', 'aigc-secrets')], 'Unknown envFrom source: ' + str(source_name)
            assert not ref.get('optional', False), 'Optional configuration source requires inspection'
            assert (kind, source_name) not in seen, 'Duplicate envFrom source'
            seen.add((kind, source_name))
            if kind == 'configMapRef':
                effective.update(settings)
            else:
                secret_path = root / 'aigc-secrets.json'
                assert secret_path.is_file(), 'Missing private aigc-secrets snapshot; use fixed update.sh'
                secret = json.loads(secret_path.read_text())
                for key, encoded in secret.get('data', {}).items():
                    try:
                        effective[key] = base64.b64decode(encoded, validate=True).decode('utf-8')
                    except (ValueError, UnicodeError):
                        raise ValueError('Secret contains an invalid environment value for key: ' + key) from None
        assert ('configMapRef', 'aigc-settings') in seen, 'API must consume aigc-settings'
        env = {e['name']: e for e in container.get('env', [])}
        def value(key):
            entry = env.get(key)
            assert not entry or 'value' in entry, key + ': indirect env needs inspection'
            return entry['value'] if entry else effective.get(key)
        base = 'https://aigcplatform.boschhuayu-steering.com'
        for key, expected in [('Cas__PublicBaseUrl', base), ('Cas__PortalBaseUrl', base), ('Cas__ServiceUrl', base + '/v1/auth/cas/callback')]:
            assert value(key) == expected, key + ': new domain must already be deployed'
        assert value('FileLogging__Directory') == '/var/log/aigc-hub', 'Unexpected log directory'
        volumes = {v['name']: v for v in spec.get('volumes', [])}
        for key in ['DataProtection__KeysPath', 'DshUploads__Root', 'Plugins__StoragePath', 'DesktopReleases__Root', 'FileLogging__Directory']:
            path = value(key)
            assert path and path.startswith('/'), key + ': explicit absolute persistent path required'
            assert any(not m.get('readOnly', False) and (path == m['mountPath'] or path.startswith(m['mountPath'].rstrip('/') + '/')) and 'persistentVolumeClaim' in volumes.get(m['name'], {}) for m in container.get('volumeMounts', [])), key + ': writable PVC required'
    prefix = '/spec/template/spec/containers/' + str(index)
    apply = [{'op': 'test', 'path': '/metadata/resourceVersion', 'value': obj['metadata']['resourceVersion']}, {'op': 'test', 'path': prefix + '/name', 'value': name}, {'op': 'replace', 'path': prefix + '/image', 'value': image}, {'op': 'add', 'path': prefix + '/imagePullPolicy', 'value': 'Never'}]
    restore = [{'op': 'test', 'path': prefix + '/name', 'value': name}, {'op': 'test', 'path': prefix + '/image', 'value': image}, {'op': 'replace', 'path': prefix + '/image', 'value': container['image']}]
    restore.append({'op': 'add', 'path': prefix + '/imagePullPolicy', 'value': container['imagePullPolicy']} if 'imagePullPolicy' in container else {'op': 'remove', 'path': prefix + '/imagePullPolicy'})
    for suffix, patch in [('apply', apply), ('restore', restore)]:
        (root / (name + '-' + suffix + '.json')).write_text(json.dumps(patch))
    state[name] = {'oldImage': container['image'], 'newImage': image}
(root / 'images.json').write_text(json.dumps(state, indent=2))
print('Preflight passed; image-only patches prepared.')
