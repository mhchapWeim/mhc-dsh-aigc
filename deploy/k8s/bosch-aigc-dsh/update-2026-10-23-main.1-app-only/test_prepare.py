import base64
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('prepare.py')
BASE = 'https://aigcplatform.boschhuayu-steering.com'

class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.secret_data = {'Jwt__Key': base64.b64encode(b'fixture-only').decode()}

    def fixture(self):
        settings = {'Cas__PublicBaseUrl': BASE, 'Cas__PortalBaseUrl': BASE, 'Cas__ServiceUrl': BASE + '/v1/auth/cas/callback'}
        for key in ['DataProtection__KeysPath', 'DshUploads__Root', 'Plugins__StoragePath', 'DesktopReleases__Root']:
            settings[key] = '/var/lib/aigc-hub/' + key
        settings['FileLogging__Directory'] = '/var/log/aigc-hub'
        def deployment(name):
            container = {'name': name, 'image': 'aigc-' + name + ':previous', 'imagePullPolicy': 'IfNotPresent'}
            if name == 'api':
                container.update(envFrom=[{'configMapRef': {'name': 'aigc-settings', 'optional': False}}, {'secretRef': {'name': 'aigc-secrets'}}], volumeMounts=[{'name': 'data', 'mountPath': '/var/lib/aigc-hub'}, {'name': 'logs', 'mountPath': '/var/log/aigc-hub'}])
            return {'metadata': {'resourceVersion': '123'}, 'spec': {'template': {'spec': {'nodeSelector': {'kubernetes.io/hostname': 'bosch-k8s-node-nj304'}, 'containers': [container], 'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'data'}}, {'name': 'logs', 'persistentVolumeClaim': {'claimName': 'logs'}}]}}}}
        return settings, deployment('api'), deployment('portal')

    def run_case(self, mutate=None, expected=True):
        settings, api, portal = self.fixture()
        if mutate: mutate(settings, api, portal)
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            for filename, obj in [('aigc-settings', {'data': settings}), ('aigc-api', api), ('aigc-portal', portal)]:
                (root / (filename + '.json')).write_text(json.dumps(obj))
            (root / 'aigc-secrets.json').write_text(json.dumps({'data': self.secret_data}))
            result = subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, expected, result.stderr)
            if expected:
                patch = json.loads((root / 'api-apply.json').read_text())
                self.assertEqual(patch[0], {'op': 'test', 'path': '/metadata/resourceVersion', 'value': '123'})
                self.assertEqual(patch[-1]['value'], 'Never')
                restore = json.loads((root / 'api-restore.json').read_text())
                self.assertEqual(restore[2]['value'], 'aigc-api:previous')
                for component in ['api', 'portal']:
                    for suffix in ['apply', 'restore']:
                        ops = json.loads((root / (component + '-' + suffix + '.json')).read_text())
                        for op in ops:
                            if op['op'] != 'test':
                                self.assertIn(op['path'], ['/spec/template/spec/containers/0/image', '/spec/template/spec/containers/0/imagePullPolicy'])
                self.assertFalse(any('/env' in op['path'] or '/volumes' in op['path'] or '/initContainers' in op['path'] for op in patch))

    def test_valid_image_only_patch(self): self.run_case()
    def test_old_domain_rejected(self): self.run_case(lambda s,a,p: s.update(Cas__PortalBaseUrl='https://old.example'), False)
    def test_wrong_node_rejected(self): self.run_case(lambda s,a,p: a['spec']['template']['spec']['nodeSelector'].clear(), False)
    def test_missing_pvc_rejected(self): self.run_case(lambda s,a,p: a['spec']['template']['spec'].update(volumes=[]), False)
    def test_indirect_env_rejected(self): self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0].update(env=[{'name': 'Cas__PublicBaseUrl', 'valueFrom': {'secretKeyRef': {'name': 'x', 'key': 'x'}}}]), False)
    def test_extra_envfrom_rejected(self): self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0]['envFrom'].append({'secretRef': {'name': 'extra'}}), False)
    def test_already_updated_rejected(self): self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0].update(image='docker.io/library/aigc-api:2026-10-23-main.1'), False)


    def test_secret_domain_override_rejected(self):
        self.secret_data['Cas__PortalBaseUrl'] = base64.b64encode(b'https://old.example').decode()
        self.run_case(expected=False)

    def test_explicit_env_wins_over_secret(self):
        self.secret_data['Cas__PortalBaseUrl'] = base64.b64encode(b'https://old.example').decode()
        self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0].update(env=[{'name':'Cas__PortalBaseUrl','value':BASE}]))

    def test_source_order_respected(self):
        self.secret_data['Cas__PortalBaseUrl'] = base64.b64encode(b'https://old.example').decode()
        self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0]['envFrom'].reverse())

    def test_known_init_preserved(self):
        def add(s,a,p):
            spec=a['spec']['template']['spec']
            spec['volumes'].append({'name':'uploads','persistentVolumeClaim':{'claimName':'aigc-dsh-uploads'}})
            spec['initContainers']=[{'name':'prepare-desktop-releases','image':'aigc-api:2026-10-08.1','imagePullPolicy':'Never','command':['sh','-c','mkdir -p /persist/desktop-releases'],'volumeMounts':[{'mountPath':'/persist','name':'uploads'}]}]
        self.run_case(add)

    def test_unknown_init_rejected(self):
        self.run_case(lambda s,a,p: a['spec']['template']['spec'].update(initContainers=[{'name':'unknown'}]),False)

    def test_prefixed_source_rejected(self):
        self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0]['envFrom'][0].update(prefix='OTHER_'),False)

    def test_existing_backup_literal_preserved(self):
        self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0].update(env=[{'name':'BackupStorage__Endpoint','value':'http://existing-storage:9000'}]))

    def test_existing_backup_secret_ref_preserved(self):
        self.run_case(lambda s,a,p: a['spec']['template']['spec']['containers'][0].update(env=[{'name':'BackupStorage__SecretKey','valueFrom':{'secretKeyRef':{'name':'existing-backup-secret','key':'secret'}}}]))

    def test_existing_backup_envfrom_preserved(self):
        self.secret_data['BackupStorage__SecretKey'] = base64.b64encode(b'existing-fixture').decode()
        self.run_case(lambda s,a,p: s.update(BackupStorage__Endpoint='http://existing-storage:9000', BackupStorage__MaximumBytes='123456'))

if __name__ == '__main__': unittest.main()
