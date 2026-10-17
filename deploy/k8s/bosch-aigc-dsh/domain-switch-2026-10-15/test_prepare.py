import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).parent
FIXTURES=HERE/'tests'/'fixtures'
spec=importlib.util.spec_from_file_location('prepare',HERE/'prepare.py')
prepare=importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def test_preserves_old_certificate_and_uses_new_certificate_for_new_sni(self):
        source=json.loads((FIXTURES/'aigc-edge-nginx.json').read_text())['data']['default.conf']
        result=prepare.dual_tls(source,443,True)
        blocks=[b for _,_,b in prepare.server_blocks(result)]
        tls=[b for b in blocks if 'listen 443 ssl;' in b]
        self.assertEqual(len(tls),2)
        old=next(b for b in tls if 'server_name '+prepare.OLD+';' in b)
        new=next(b for b in tls if 'server_name '+prepare.NEW+';' in b)
        self.assertNotIn(prepare.NEW,old.split('server_name ',1)[1].split(';',1)[0])
        self.assertIn('/etc/nginx/tls/tls.crt',old)
        self.assertIn('/etc/nginx/tls-platform/tls.crt',new)
        self.assertIn('return 308',old)
        self.assertNotIn('return 308',new)
        self.assertIn('location ^~ /dsh-desk/',new)
        self.assertIn('location ~ ^/(api|v1|health|swagger)',old)

    def test_live_fixture_generates_distinct_proxy_patches_and_preserves_upstream(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for path in FIXTURES.glob('*.json'):
                (root/path.name).write_text(path.read_text())
            (root/'aigc-secrets.json').write_text(json.dumps({'data':{}}))
            prepare.prepare(root)
            patch=json.loads((root/'settings-apply.json').read_text())['data']
            self.assertNotIn('LiteLlm__BaseUrl',patch)
            self.assertNotIn('BochaSearch__Endpoint',patch)
            self.assertEqual(patch['Cas__PublicBaseUrl'],'https://'+prepare.NEW)
            proxy_apply=json.loads((root/'nj304-litellm-proxy-deployment-apply.json').read_text())
            volume=proxy_apply['spec']['template']['spec']['volumes'][0]
            self.assertEqual(volume['secret']['secretName'],'aigc-platform-tls')
            restore=json.loads((root/'nj304-litellm-proxy-deployment-restore.json').read_text())
            self.assertIn('$patch',restore['spec']['template']['spec']['volumes'][0])
            self.assertIn('data',json.loads((root/'nj304-litellm-proxy-apply.json').read_text()))

    def test_refuses_already_modified_tls_configuration(self):
        source=json.loads((FIXTURES/'aigc-edge-nginx.json').read_text())['data']['default.conf']
        with self.assertRaises(ValueError):
            prepare.dual_tls(prepare.dual_tls(source,443,True),443,True)


if __name__=='__main__': unittest.main()
