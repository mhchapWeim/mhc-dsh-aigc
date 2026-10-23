"""Prepare a JSON patch from a live ConfigMap; do not deploy or read secrets."""
import json
from pathlib import Path
import re
import sys


def prepare(snapshot, output):
    obj = json.loads(Path(snapshot).read_text(encoding="utf-8-sig"))
    if obj["metadata"]["name"] != "nj304-litellm-proxy":
        raise ValueError("Expected nj304-litellm-proxy ConfigMap")
    original = obj["data"]["default.conf"]
    if "/api-ws/" in original:
        raise ValueError("ASR route already present; inspect before changing it")
    snippet = Path(__file__).with_name("internal.location.conf").read_text(encoding="utf-8")
    # Existing old/new SNI servers each have a healthz location. Preserve both.
    candidate, count = re.subn(
        r"(?m)^([ \t]*)location\s*=\s*/healthz\s*\{",
        lambda m: "\n".join(m[1] + line for line in snippet.rstrip().splitlines())
        + "\n" + m[0], original)
    if not count:
        raise ValueError("No healthz insertion anchor; inspect live configuration")
    patch = [
        {"op": "test", "path": "/data/default.conf", "value": original},
        {"op": "replace", "path": "/data/default.conf", "value": candidate},
    ]
    restore = [
        {"op": "test", "path": "/data/default.conf", "value": candidate},
        {"op": "replace", "path": "/data/default.conf", "value": original},
    ]
    root = Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for name, value in [("apply.json", patch), ("restore.json", restore)]:
        (root / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    (root / "default.conf").write_text(candidate, encoding="utf-8")
    (root / "check.conf").write_text("events {}\nhttp {\n" + candidate + "\n}\n", encoding="utf-8")
    print(f"Prepared ASR route in {count} server(s); existing configuration preserved")


if __name__ == "__main__":
    prepare(*sys.argv[1:])
