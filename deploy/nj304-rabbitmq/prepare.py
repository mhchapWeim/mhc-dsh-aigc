"""Generate nj304 MQ topology and salted password hashes; never print or persist plaintext secrets."""
import base64
import hashlib
import json
import os
from pathlib import Path


def password_hash(value):
    salt = os.urandom(4)
    return base64.b64encode(salt + hashlib.sha256(salt + value.encode("utf-8")).digest()).decode("ascii")


def main():
    names = [("aigc_mq_admin", "MQ_ADMIN_PASSWORD", "administrator"),
             ("aigc_user_producer", "MQ_PRODUCER_PASSWORD", ""),
             ("aigc_user_service_1", "MQ_CONSUMER_PASSWORD", "")]
    secrets = [os.environ.get(key, "") for _, key, _ in names]
    if any(len(value) < 16 for value in secrets) or len(set(secrets)) != len(secrets):
        raise SystemExit("Supply distinct passwords of at least 16 characters using MQ_ADMIN_PASSWORD, MQ_PRODUCER_PASSWORD and MQ_CONSUMER_PASSWORD.")
    exchange = "aigc.identity.users"
    queue = "aigc.users.service-1"
    vhost = "/aigc"
    definition = {
        "users": [{"name": user, "password_hash": password_hash(secret), "hashing_algorithm": "rabbit_password_hashing_sha256", "tags": tag}
                  for (user, _, tag), secret in zip(names, secrets)],
        "vhosts": [{"name": vhost}],
        "permissions": [
            {"user": "aigc_mq_admin", "vhost": vhost, "configure": ".*", "write": ".*", "read": ".*"},
            {"user": "aigc_user_producer", "vhost": vhost, "configure": "^$", "write": "^aigc\\.identity\\.users$", "read": "^$"},
            {"user": "aigc_user_service_1", "vhost": vhost, "configure": "^$", "write": "^$", "read": "^aigc\\.users\\.service-1$"},
        ],
        "exchanges": [{"name": exchange, "vhost": vhost, "type": "topic", "durable": True, "auto_delete": False, "internal": False, "arguments": {}}],
        "queues": [{"name": queue, "vhost": vhost, "durable": True, "auto_delete": False, "arguments": {"x-queue-type": "quorum"}}],
        "bindings": [{"source": exchange, "vhost": vhost, "destination": queue, "destination_type": "queue", "routing_key": "aigc.user.*.v1", "arguments": {}}],
    }
    directory = Path(__file__).resolve().parent / "generated"
    directory.mkdir(exist_ok=True)
    target = directory / "definitions.json"
    target.write_text(json.dumps(definition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        target.chmod(0o600)
    except OSError:
        pass  # Windows ACLs are inherited; protect this deployment directory on the host.
    print("Generated hashed credentials and topology in generated/definitions.json; no plaintext secrets were saved.")


if __name__ == "__main__":
    main()
