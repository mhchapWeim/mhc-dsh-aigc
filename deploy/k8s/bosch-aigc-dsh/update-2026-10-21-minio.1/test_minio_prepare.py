import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('base_tests',HERE/'test_prepare.py')
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

class MinioPrepareTests(unittest.TestCase):
    def patch(self, replicas=1, env=None, expected=True):
        settings,api,portal=base.PrepareTests().fixture()
        api['spec']['replicas']=replicas
        if env is not None: api['spec']['template']['spec']['containers'][0]['env']=env
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            for name,value in [('aigc-settings',{'data':settings}),('aigc-secrets',{'data':{}}),('aigc-api',api),('aigc-portal',portal)]:
                (root/f'{name}.json').write_text(json.dumps(value))
            result=subprocess.run([sys.executable,str(HERE/'prepare.py'),folder],capture_output=True,text=True)
            self.assertEqual(result.returncode==0,expected,result.stderr)
            if expected:
                patch=json.loads((root/'api-apply.json').read_text())
                new=patch[-1]['value']
                self.assertEqual(next(e for e in new if e['name']=='BackupStorage__Enabled')['value'],'true')
                access=next(e for e in new if e['name']=='BackupStorage__AccessKey')
                self.assertIn('secretKeyRef',access['valueFrom'])
                restore=json.loads((root/'api-restore.json').read_text())[-1]
                if env is None: self.assertEqual(restore['op'],'remove')
                else:
                    self.assertEqual(restore['value'],env)
                    for entry in env:
                        if not entry['name'].startswith('BackupStorage__'): self.assertIn(entry,new)
    def test_enable_and_restore_absent_env(self): self.patch()
    def test_preserve_unrelated_env(self): self.patch(env=[{'name':'CUSTOM_SETTING','value':'keep'}])
    def test_restore_disabled_config(self): self.patch(env=[{'name':'BackupStorage__Enabled','value':'false'}])
    def test_reject_multiple_api_replicas(self): self.patch(replicas=2,expected=False)
    def test_reject_storage_switch(self): self.patch(env=[{'name':'BackupStorage__Bucket','value':'other'}],expected=False)
    def resources(self, resources=None, expected=True):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder)
            for name in ['pv','pvc','deployment','service','secret']:
                obj=(resources or {}).get(name)
                (root/f'minio-{name}.json').write_text(json.dumps(obj) if obj else '')
            result=subprocess.run([sys.executable,str(HERE/'minio_prepare.py'),folder,'--create-secret'],capture_output=True,text=True)
            self.assertEqual(result.returncode==0,expected,result.stderr)
            if expected:
                secret=json.loads((root/'minio-new-secret.json').read_text())
                self.assertEqual(secret['stringData']['root-user'],'admin')
                self.assertNotEqual(secret['stringData']['secret-key'],secret['stringData']['root-password'])
    def test_new_secret_is_separate_app_account(self): self.resources()
    def test_reject_existing_storage_without_secret(self): self.resources({'pvc':{'spec':{'volumeName':'aigc-backup-minio'},'status':{'phase':'Bound'}}},False)
    def test_reject_public_service(self): self.resources({'service':{'spec':{'type':'NodePort'}}},False)
    def test_reject_wrong_pv(self): self.resources({'pv':{'spec':{'local':{'path':'/other'}}}},False)

if __name__=='__main__': unittest.main()
