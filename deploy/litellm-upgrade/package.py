#!/usr/bin/env python3
"""Create portable ZIP and checksums, excluding private build cache and backups."""
import hashlib
import argparse
import json
import pathlib
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--suffix', default='')
    args = parser.parse_args()
    if args.suffix and not re.fullmatch(r'[a-z0-9-]+', args.suffix):
        raise ValueError('Invalid package suffix')
    meta = json.loads((ROOT / 'image.json').read_text())
    files = [ROOT / name for name in [
        'README.md', 'upgrade.sh', 'check.sh', 'rollback.sh', 'service.sh', 'manager.py',
        'prepare-release.sh', 'package.py', 'fetch-image.py', 'test_manager.py',
        'image.json', 'signature-verification.json', 'cosign.pub', 'VALIDATION.md', 'PG-VALIDATION.json', meta['archive']]]
    for path in files:
        if not path.is_file():
            raise RuntimeError('Missing: ' + str(path))
    assert digest(ROOT / meta['archive']) == meta['archive_sha256']
    sums = ROOT / 'SHA256SUMS'
    sums.write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in files), encoding='utf-8')
    target = ROOT.parent / ('litellm-upgrade-%s-linux-amd64%s.zip' %
                            (meta['version'], '-' + args.suffix if args.suffix else ''))
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as z:
        for path in files + [sums]:
            z.write(path, 'litellm-upgrade/' + path.name)
    target.with_suffix('.zip.sha256').write_text(digest(target) + '  ' + target.name + '\n')
    print(target)
    print('Bytes:', target.stat().st_size)


if __name__ == '__main__':
    main()
