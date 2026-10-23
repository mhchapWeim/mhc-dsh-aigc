"""Prepare image-only JSON patches from the actual Portal Deployment."""
import json
import pathlib
import sys

IMAGE = 'aigc-portal:2026-10-21-model-layout.1'
NODE = 'bosch-k8s-node-nj304'


def patches(deployment):
    if deployment['metadata']['name'] != 'aigc-portal':
        raise ValueError('Expected Deployment aigc-portal')
    if not deployment['metadata'].get('resourceVersion'):
        raise ValueError('Missing resourceVersion')
    if deployment['spec'].get('replicas', 1) < 1:
        raise ValueError('Portal is scaled to zero; inspect before updating')
    spec = deployment['spec']['template']['spec']
    if spec.get('nodeSelector', {}).get('kubernetes.io/hostname') != NODE:
        raise ValueError('Unexpected nodeSelector; import the image on the actual eligible nodes first')
    containers = spec['containers']
    matches = [(i, c) for i, c in enumerate(containers) if c['name'] == 'portal']
    if len(matches) != 1:
        raise ValueError('Expected one container named portal')
    index, container = matches[0]
    if not container.get('image'):
        raise ValueError('Missing old Portal image')
    if container['image'].split('/')[-1] == IMAGE:
        raise ValueError('Target image already configured; use verify.sh instead')
    prefix = f'/spec/template/spec/containers/{index}'
    update = [
        {'op': 'test', 'path': '/metadata/resourceVersion', 'value': deployment['metadata']['resourceVersion']},
        {'op': 'test', 'path': prefix + '/name', 'value': 'portal'},
        {'op': 'test', 'path': prefix + '/image', 'value': container['image']},
        {'op': 'replace', 'path': prefix + '/image', 'value': IMAGE},
        {'op': 'add', 'path': prefix + '/imagePullPolicy', 'value': 'Never'},
    ]
    rollback = [
        {'op': 'test', 'path': prefix + '/name', 'value': 'portal'},
        {'op': 'test', 'path': prefix + '/image', 'value': IMAGE},
        {'op': 'replace', 'path': prefix + '/image', 'value': container['image']},
        {'op': 'add', 'path': prefix + '/imagePullPolicy', 'value': container['imagePullPolicy']}
        if 'imagePullPolicy' in container else {'op': 'remove', 'path': prefix + '/imagePullPolicy'},
    ]
    return update, rollback


if __name__ == '__main__':
    folder = pathlib.Path(sys.argv[1])
    update, rollback = patches(json.loads((folder / 'aigc-portal.json').read_text()))
    for name, patch in [('apply.json', update), ('rollback.json', rollback)]:
        (folder / name).write_text(json.dumps(patch, indent=2) + '\n')
    print('Preflight passed; Portal image-only patches prepared.')
