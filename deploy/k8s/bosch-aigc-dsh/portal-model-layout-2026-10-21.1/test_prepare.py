import copy
import unittest
from prepare import IMAGE, NODE, patches


def fixture():
    return {'metadata': {'name': 'aigc-portal', 'resourceVersion': '42'}, 'spec': {'replicas': 1, 'template': {'spec': {
        'nodeSelector': {'kubernetes.io/hostname': NODE},
        'containers': [{'name': 'portal', 'image': 'aigc-portal:old', 'imagePullPolicy': 'Never',
                        'env': [{'name': 'PORT', 'value': '3000'}], 'envFrom': [{'configMapRef': {'name': 'existing'}}]}],
        'initContainers': [{'name': 'existing-init', 'image': 'existing:old'}], 'volumes': [{'name': 'existing-volume'}]}}}}


class PrepareTests(unittest.TestCase):
    def test_changes_only_image_and_pull_policy_and_leaves_input_intact(self):
        original = fixture()
        before = copy.deepcopy(original)
        apply, rollback = patches(original)
        self.assertEqual(before, original)
        self.assertEqual({item['path'] for item in apply if item['op'] != 'test'}, {
            '/spec/template/spec/containers/0/image', '/spec/template/spec/containers/0/imagePullPolicy'})
        self.assertEqual(apply[0]['value'], '42')
        self.assertEqual(rollback[1]['value'], IMAGE)
        self.assertEqual(rollback[2]['value'], 'aigc-portal:old')

    def test_sidecar_order_is_respected(self):
        obj = fixture()
        obj['spec']['template']['spec']['containers'].insert(0, {'name': 'sidecar', 'image': 'keep'})
        self.assertIn('/containers/1/image', patches(obj)[0][3]['path'])

    def test_absent_policy_is_removed_on_rollback(self):
        obj = fixture()
        del obj['spec']['template']['spec']['containers'][0]['imagePullPolicy']
        self.assertEqual(patches(obj)[1][-1]['op'], 'remove')

    def test_rejects_wrong_node(self):
        obj = fixture()
        obj['spec']['template']['spec']['nodeSelector'] = {}
        with self.assertRaises(ValueError): patches(obj)

    def test_rejects_wrong_deployment_or_missing_container(self):
        obj = fixture()
        obj['metadata']['name'] = 'aigc-api'
        with self.assertRaises(ValueError): patches(obj)
        obj = fixture()
        obj['spec']['template']['spec']['containers'][0]['name'] = 'api'
        with self.assertRaises(ValueError): patches(obj)

    def test_rejects_already_updated_or_scaled_to_zero(self):
        obj = fixture()
        obj['spec']['template']['spec']['containers'][0]['image'] = 'docker.io/library/' + IMAGE
        with self.assertRaises(ValueError): patches(obj)
        obj = fixture()
        obj['spec']['replicas'] = 0
        with self.assertRaises(ValueError): patches(obj)


if __name__ == '__main__': unittest.main()
