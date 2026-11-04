"""Generate additive hot-update topology; no production connection or plaintext secret output."""
import json
import os
from pathlib import Path
from prepare import password_hash


def definition(password):
    if len(password) < 16:
        raise ValueError("MQ_CONFIG_PASSWORD must contain at least 16 characters")
    exchange = "aigc.config.events"
    queues = r"aigc\.config\.api\.[a-f0-9]{32}"
    resources = rf"^(aigc\.config\.events|{queues})$"
    return {
        "users": [{"name": "aigc_config_runtime", "password_hash": password_hash(password),
                   "hashing_algorithm": "rabbit_password_hashing_sha256", "tags": ""}],
        "vhosts": [{"name": "/aigc"}],
        "permissions": [{"user": "aigc_config_runtime", "vhost": "/aigc", "configure": rf"^{queues}$",
                         "write": resources, "read": resources}],
        "exchanges": [{"name": exchange, "vhost": "/aigc", "type": "topic", "durable": True,
                       "auto_delete": False, "internal": False, "arguments": {}}],
    }


if __name__ == "__main__":
    data = definition(os.environ.get("MQ_CONFIG_PASSWORD", ""))
    root = Path(__file__).resolve().parent / "generated"
    root.mkdir(exist_ok=True)
    output = root / "config-sync-definitions.json"
    output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)
    print("Generated additive configuration topology with salted password hash; plaintext was not saved.")
