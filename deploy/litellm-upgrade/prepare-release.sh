#!/usr/bin/env bash
# 在有 Docker、cosign 和外网的 Linux amd64 制包机运行；目标 DMZ 不需要 cosign/外网。
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-v1.106.2}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$VERSION" != v1.107.0 ]] || { echo '拒绝非正式版本或已报告的危险版本' >&2; exit 1; }
for tool in docker cosign python3 gzip curl; do command -v "$tool" >/dev/null; done
IMAGE="ghcr.io/berriai/litellm:$VERSION"
KEY_URL='https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub'
STAGE="$(mktemp -d "$ROOT/.prepare.XXXXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 "$KEY_URL" -o "$STAGE/cosign.pub"
cosign verify --key "$STAGE/cosign.pub" "$IMAGE" > "$STAGE/signature-verification.json"
DIGEST="$(python3 - "$STAGE/signature-verification.json" <<'PY'
import json,re,sys
items=json.load(open(sys.argv[1]))
digests={x['critical']['image']['docker-manifest-digest'] for x in items}
assert len(digests)==1
d=digests.pop()
assert re.fullmatch('sha256:[0-9a-f]{64}',d)
print(d)
PY
)"
PINNED="ghcr.io/berriai/litellm@$DIGEST"
docker pull --platform linux/amd64 "$PINNED"
docker image inspect "$PINNED" > "$STAGE/inspect.json"
IMAGE_ID="$(python3 - "$STAGE/inspect.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))[0]['Id'])
PY
)"
ARCHIVE="litellm-$VERSION-linux-amd64.tar.gz"
docker image save "$IMAGE_ID" | gzip -1 > "$STAGE/$ARCHIVE"
python3 - "$STAGE" "$VERSION" "$DIGEST" "$ARCHIVE" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]); version,digest,archive=sys.argv[2:]
c=json.load(open(p/'inspect.json'))[0]
assert c['Architecture']=='amd64' and c['Os']=='linux'
h=hashlib.sha256()
with (p/archive).open('rb') as f:
    for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
(p/'image.json').write_text(json.dumps(dict(version=version,image='ghcr.io/berriai/litellm:'+version,
    platform='linux/amd64',index_digest=digest,image_id=c['Id'],archive=archive,
    archive_sha256=h.hexdigest()),indent=2)+'\n')
PY
# Only publish after all downloads, signature checks, and archive creation have succeeded.
mv -- "$STAGE/$ARCHIVE" "$ROOT/$ARCHIVE"
mv -- "$STAGE/image.json" "$ROOT/image.json"
mv -- "$STAGE/signature-verification.json" "$ROOT/signature-verification.json"
mv -- "$STAGE/cosign.pub" "$ROOT/cosign.pub"
python3 "$ROOT/package.py"
echo '新版本交付包制作完成。请先在隔离环境验证迁移和恢复，再更新生产。'
