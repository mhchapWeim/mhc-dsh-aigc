import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('configure_workflow', Path(__file__).with_name('configure-workflow.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigPatchTests(unittest.TestCase):
    def test_split_preserves_secrets_and_removes_shadowing_public_keys(self):
        host = 'IntegrationConnections__CodeAudit__HostName'
        password = 'IntegrationConnections__CodeAudit__Password'
        cm, patch = module.split_api_settings({host: 'aigc-mq', password: 'test-only'})
        self.assertNotIn(password, cm['data'])
        self.assertEqual(patch['stringData'], {password: 'test-only'})
        self.assertEqual(patch['data'], {host: None})
        original = {host: 'old', password: 'old', 'Cas__Enabled': 'true', 'IntegrationConnections__CodeAudit__CallbackSecret': 'retained'}
        for key in patch['data']: original.pop(key, None)
        original.update(patch['stringData'])
        self.assertEqual(original['Cas__Enabled'], 'true')
        self.assertEqual(original['IntegrationConnections__CodeAudit__CallbackSecret'], 'retained')
        self.assertEqual(original[password], 'test-only')

    def test_merge_definitions_keeps_other_live_and_bootstrap_resources(self):
        merged = module.merge_definitions({'queues': [{'vhost': '/aigc', 'name': 'boot'}]}, {'queues': [{'vhost': '/aigc', 'name': 'live'}]})
        self.assertEqual({q['name'] for q in merged['queues']}, {'boot', 'live'})


if __name__ == '__main__': unittest.main()
