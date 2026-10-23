#!/usr/bin/env python3
"""Fetch a pinned official GHCR image without requiring a Docker daemon."""
import concurrent.futures
import gzip
import hashlib
import io
import json
import pathlib
import shutil
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
REPO = 'berriai/litellm'
VERSION = 'v1.106.2'
INDEX = 'sha256:7294b90f868c5c38c99b83021c7ba46f9b439e95f8e32964c925c7d2563a03f7'
MANIFEST = 'sha256:d1da6edc025e6a59be6faa50b4e8e42c115e1c99644aa3fc2ac416dd353f41da'


def main():
    cache = ROOT / '.build'
    cache.mkdir(exist_ok=True)
    token = json.load(urllib.request.urlopen(
        f'https://ghcr.io/token?service=ghcr.io&scope=repository:{REPO}:pull', timeout=60))['token']

    def get(kind, digest):
        req = urllib.request.Request(f'https://ghcr.io/v2/{REPO}/{kind}/{digest}', headers={
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json'})
        return urllib.request.urlopen(req, timeout=120)

    def verified_json(digest):
        with get('manifests', digest) as r:
            data = r.read()
        assert 'sha256:' + hashlib.sha256(data).hexdigest() == digest
        return json.loads(data)

    index = verified_json(INDEX)
    assert any(x['digest'] == MANIFEST and x['platform'] == {'architecture': 'amd64', 'os': 'linux'}
               for x in index['manifests'])
    manifest = verified_json(MANIFEST)

    def download(desc):
        digest = desc['digest']
        dest = cache / digest.split(':')[1]
        if dest.exists() and hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest() == digest.split(':')[1]:
            return dest
        for attempt in range(4):
            try:
                h = hashlib.sha256()
                with get('blobs', digest) as src, dest.open('wb') as out:
                    while chunk := src.read(1024 * 1024):
                        out.write(chunk)
                        h.update(chunk)
                assert dest.stat().st_size == desc['size']
                assert h.hexdigest() == digest.split(':')[1]
                print('Verified blob', digest[:25], desc['size'], flush=True)
                return dest
            except Exception:
                dest.unlink(missing_ok=True)
                if attempt == 3:
                    raise

    descriptors = [manifest['config']] + manifest['layers']
    print('Compressed download bytes:', sum(x['size'] for x in descriptors), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        blobs = list(pool.map(download, descriptors))
    cfg = json.loads(blobs[0].read_bytes())
    assert cfg['architecture'] == 'amd64' and cfg['os'] == 'linux'
    config_name = manifest['config']['digest'].split(':')[1] + '.json'
    layers = []
    target = ROOT / ('litellm-' + VERSION + '-linux-amd64.tar.gz')
    with tarfile.open(str(target) + '.partial', 'w:gz', compresslevel=1) as out:
        out.add(blobs[0], arcname=config_name)
        for i, (desc, blob) in enumerate(zip(manifest['layers'], blobs[1:])):
            name = desc['digest'].split(':')[1] + '/layer.tar'
            raw = cache / 'layer.raw'
            with gzip.open(blob, 'rb') as src, raw.open('wb') as dest:
                shutil.copyfileobj(src, dest, 1024 * 1024)
            with raw.open('rb') as f:
                assert 'sha256:' + hashlib.file_digest(f, 'sha256').hexdigest() == cfg['rootfs']['diff_ids'][i]
            out.add(raw, arcname=name)
            raw.unlink()
            layers.append(name)
            print('Packed layer', i + 1, '/', len(blobs) - 1, flush=True)
        data = json.dumps([{'Config': config_name, 'RepoTags': [f'ghcr.io/{REPO}:{VERSION}'],
                            'Layers': layers}]).encode()
        info = tarfile.TarInfo('manifest.json')
        info.size = len(data)
        out.addfile(info, io.BytesIO(data))
    pathlib.Path(str(target) + '.partial').replace(target)
    metadata = {'version': VERSION, 'image': f'ghcr.io/{REPO}:{VERSION}', 'platform': 'linux/amd64',
                'index_digest': INDEX, 'manifest_digest': MANIFEST,
                'image_id': manifest['config']['digest'], 'archive': target.name,
                'archive_sha256': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest()}
    (ROOT / 'image.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print('Image archive complete:', target, flush=True)


if __name__ == '__main__':
    main()
