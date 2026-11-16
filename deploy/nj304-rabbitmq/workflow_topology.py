"""Additive topology for the existing nj304 RabbitMQ 4.2 /aigc vhost."""
import base64
import hashlib
import os

VHOST = "/aigc"
COMMANDS = "aigc.workflow.commands"
DLX = "aigc.workflow.dead-letter"
DLQ = "aigc.workflow.dead-letters"
RUNTIME = "aigc_workflow_runtime"
SERVICES = {
    "code-audit": ("aigc_code_audit", "code-audit.submit.v1", "audit.completed.v1"),
    "deployment": ("aigc_deployment", "deployment.submit.v1", "deploy.completed.v1"),
}


def password_hash(password):
    if len(password) < 20:
        raise ValueError("Each workflow password must contain at least 20 characters")
    salt = os.urandom(4)
    return base64.b64encode(salt + hashlib.sha256(salt + password.encode()).digest()).decode()


def matches_password(password, encoded):
    raw = base64.b64decode(encoded)
    return raw[4:] == hashlib.sha256(raw[:4] + password.encode()).digest()


def topology(passwords=None):
    exchanges = [dict(name=COMMANDS, type="direct"), dict(name=DLX, type="fanout")]
    queues = [DLQ]
    bindings = [dict(source=DLX, destination=DLQ, routing_key="")]
    permissions = [dict(user=RUNTIME, configure="^$", write=r"^aigc\.workflow\.commands$",
                        read=r"^aigc\.workflow\.(code-audit|deployment)\.results$")]
    for service, (user, request_key, result_key) in SERVICES.items():
        request_queue = f"aigc.workflow.{service}.requests"
        result_exchange = f"aigc.workflow.{service}.results"
        exchanges.append(dict(name=result_exchange, type="direct"))
        queues.extend([request_queue, result_exchange])
        bindings.extend([dict(source=COMMANDS, destination=request_queue, routing_key=request_key),
                         dict(source=result_exchange, destination=result_exchange, routing_key=result_key)])
        if service == "code-audit":
            bindings.extend(dict(source=result_exchange, destination=result_exchange, routing_key=event)
                            for event in ("review.finished", "review.rejected"))
        permissions.append(dict(user=user, configure="^$", write="^" + result_exchange.replace(".", r"\.") + "$",
                                read="^" + request_queue.replace(".", r"\.") + "$"))
    users = [] if passwords is None else [dict(name=u, password_hash=password_hash(passwords[u]),
        hashing_algorithm="rabbit_password_hashing_sha256", tags="") for u in [RUNTIME] + [v[0] for v in SERVICES.values()]]
    return dict(users=users, vhosts=[dict(name=VHOST)],
        permissions=[dict(vhost=VHOST, **p) for p in permissions],
        exchanges=[dict(vhost=VHOST, durable=True, auto_delete=False, internal=False, arguments={}, **e) for e in exchanges],
        queues=[dict(vhost=VHOST, name=q, durable=True, auto_delete=False, arguments={"x-queue-type": "quorum"}) for q in queues],
        bindings=[dict(vhost=VHOST, destination_type="queue", arguments={}, **b) for b in bindings],
        policies=[dict(vhost=VHOST, name="aigc-workflow-live", pattern=r"^aigc\.workflow\.(code-audit|deployment)\.(requests|results)$", priority=50, **{"apply-to": "quorum_queues"},
            definition={"message-ttl": 604800000, "max-length": 10000, "max-length-bytes": 268435456,
                "overflow": "reject-publish", "dead-letter-exchange": DLX, "dead-letter-strategy": "at-least-once", "delivery-limit": 20}),
            dict(vhost=VHOST, name="aigc-workflow-dead", pattern=r"^aigc\.workflow\.dead-letters$", priority=50, **{"apply-to": "quorum_queues"},
            definition={"message-ttl": 1209600000, "max-length": 10000, "max-length-bytes": 268435456, "overflow": "reject-publish"})])
