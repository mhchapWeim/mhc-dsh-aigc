"""Offline fixture check. No kubectl, SSH, Docker or production state is touched."""
import json
import pathlib
import subprocess
import sys
import tempfile

package = pathlib.Path(__file__).resolve().parents[1]
script = (package / "update.sh").read_text()
code = script.split("python3 - \"$backup\" <<'PY'\n", 1)[1].split("\nPY", 1)[0]
with tempfile.TemporaryDirectory(prefix="aigc-update-preflight-") as temporary:
    root = pathlib.Path(temporary)
    for name, container in [("aigc-api", "api"), ("aigc-portal", "portal")]:
        spec = {
            "nodeSelector": {"kubernetes.io/hostname": "bosch-k8s-node-nj304"},
            "containers": [{"name": container, "image": f"{name}:old", "env": [
                {"name": "KEEP_ME", "value": "preserved"},
                {"name": "FileLogging__Directory", "valueFrom": {"configMapKeyRef": {"name": "old", "key": "path"}}}],
                "volumeMounts": [{"name": "uploads", "mountPath": "/var/lib/aigc-hub/dsh-uploads"}]}],
            "volumes": [{"name": "uploads", "persistentVolumeClaim": {"claimName": "aigc-dsh-uploads"}}]}
        (root / f"{name}.json").write_text(json.dumps({"spec": {"template": {"spec": spec}}}))
    (root / "aigc-settings.json").write_text(json.dumps({"data": {}}))
    subprocess.run([sys.executable, "-c", code, str(root)], check=True)
    apply = json.loads((root / "api-apply.json").read_text())["spec"]["template"]["spec"]
    restore = json.loads((root / "api-restore.json").read_text())["spec"]["template"]["spec"]
    env = apply["containers"][0]["env"]
    assert env[0] == {"$patch": "replace"}
    assert {"name": "KEEP_ME", "value": "preserved"} in env
    entry = next(e for e in env if e.get("name") == "FileLogging__Directory")
    assert entry["value"] == "/var/log/aigc-hub" and "valueFrom" not in entry
    assert restore["containers"][0]["image"] == "aigc-api:old"
    assert restore["volumes"][0] == {"$patch": "replace"}
    assert restore["containers"][0]["volumeMounts"][0] == {"$patch": "replace"}
    assert restore["containers"][0]["env"][2]["valueFrom"]
    source = json.loads((root / "aigc-api.json").read_text())
    source["spec"]["template"]["spec"]["nodeSelector"] = {}
    (root / "aigc-api.json").write_text(json.dumps(source))
    result = subprocess.run([sys.executable, "-c", code, str(root)], capture_output=True)
    assert result.returncode != 0
print("PASS: preserved env, replaced conflicting valueFrom, persistent storage additions, rollback fields, wrong-node rejection")
