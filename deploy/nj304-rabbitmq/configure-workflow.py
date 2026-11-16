#!/usr/bin/env python3
"""Provision only workflow resources, persist merged boot definitions, optionally patch API configuration.

Default is an offline plan. --apply runs on a Kubernetes control node with kubectl.
Passwords are read via getpass and are never included in arguments or output.
"""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from workflow_topology import topology, matches_password, VHOST, SERVICES, RUNTIME


def private_json(path, value):
    with open(path, "w", encoding="utf-8", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def kubectl(namespace, *args, capture=False):
    result = subprocess.run(["kubectl", "-n", namespace, *args], check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if capture else None


def merge_definitions(saved, current):
    """Keep old boot entries and every live resource, with live entries taking precedence."""
    keys = {"users": ("name",), "vhosts": ("name",), "permissions": ("vhost", "user"),
        "topic_permissions": ("vhost", "user", "exchange"), "exchanges": ("vhost", "name"),
        "queues": ("vhost", "name"), "bindings": ("vhost", "source", "destination", "destination_type", "routing_key", "arguments"),
        "policies": ("vhost", "name"), "parameters": ("vhost", "component", "name"), "global_parameters": ("name",)}
    merged = {**saved, **current}
    for kind, fields in keys.items():
        entries = {}
        for row in saved.get(kind, []) + current.get(kind, []):
            entries[tuple(json.dumps(row.get(k), sort_keys=True) for k in fields)] = row
        if entries: merged[kind] = list(entries.values())
    return merged


def split_api_settings(values):
    """Move public workflow keys to ConfigMap; delete only those shadowing Secret keys."""
    public = {k: v for k, v in values.items() if not k.endswith("__Password")}
    secret = {"stringData": {k: v for k, v in values.items() if k.endswith("__Password")},
              "data": {k: None for k in public}}
    return {"data": public}, secret


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--namespace", default="bosch-aigc-dsh")
    parser.add_argument("--local-port", type=int, default=18672)
    parser.add_argument("--patch-api", action="store_true", help="Merge only CodeAudit/Deployment connection keys into existing aigc-secrets; does not restart API")
    parser.add_argument("--patch-configmap", action="store_true", help="With --patch-api, store non-secret workflow settings in existing aigc-settings and passwords in aigc-secrets")
    args = parser.parse_args()
    if args.patch_configmap and not args.patch_api:
        parser.error("--patch-configmap requires --patch-api")
    if not args.apply:
        print(json.dumps(topology(), indent=2)); return
    os.umask(0o077)
    backup = Path(tempfile.mkdtemp(prefix="workflow-mq-backup-", dir=".")).resolve()
    service = kubectl(args.namespace, "get", "service", "aigc-mq", "-o", "json", capture=True)
    private_json(backup / "aigc-mq.service.before.json", service)
    if service["spec"]["type"] != "NodePort" or not any(p.get("name") == "amqp" and p.get("nodePort") == 30672 for p in service["spec"]["ports"]):
        raise ValueError("MQ Service differs from the user-confirmed NodePort/30672 baseline; inspect it before proceeding")
    bootstrap = kubectl(args.namespace, "get", "secret", "aigc-mq-definitions", "-o", "json", capture=True)
    private_json(backup / "aigc-mq-definitions.before.json", bootstrap)
    original = json.loads(base64.b64decode(bootstrap["data"]["definitions.json"]))
    if args.patch_api:
        api_secret = kubectl(args.namespace, "get", "secret", "aigc-secrets", "-o", "json", capture=True)
        private_json(backup / "aigc-secrets.before.json", api_secret)
    if args.patch_configmap:
        settings = kubectl(args.namespace, "get", "configmap", "aigc-settings", "-o", "json", capture=True)
        private_json(backup / "aigc-settings.before.json", settings)
        deployment = kubectl(args.namespace, "get", "deployment", "aigc-api", "-o", "json", capture=True)
        container = next(c for c in deployment["spec"]["template"]["spec"]["containers"] if c["name"] == "api")
        refs = container.get("envFrom", [])
        if not any(r.get("configMapRef", {}).get("name") == "aigc-settings" for r in refs) or not any(r.get("secretRef", {}).get("name") == "aigc-secrets" for r in refs):
            raise ValueError("API must already reference aigc-settings and aigc-secrets via envFrom")
        if any(e["name"].startswith(("IntegrationConnections__CodeAudit__", "IntegrationConnections__Deployment__")) for e in container.get("env", [])):
            raise ValueError("Explicit API env overrides workflow settings; reconcile it before patching")
    admin = input("Existing MQ administrator [aigc_mq_admin]: ").strip() or "aigc_mq_admin"
    admin_password = getpass.getpass("Existing MQ administrator password: ")
    passwords = {}
    for user in [RUNTIME] + [v[0] for v in SERVICES.values()]:
        password = getpass.getpass(f"Password for {user} (20+ characters; securely retain it): ")
        if len(password) < 20 or password != getpass.getpass("Confirm: "): raise ValueError("Password too short or confirmation mismatch")
        passwords[user] = password
    desired = topology(passwords)
    headers = {"Content-Type": "application/json", "Authorization": "Basic " + base64.b64encode(f"{admin}:{admin_password}".encode()).decode()}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    quote = lambda v: urllib.parse.quote(v, safe="")

    def api(method, path, data=None, missing=False):
        request = urllib.request.Request(f"http://127.0.0.1:{args.local_port}/api/{path}", method=method,
            data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with opener.open(request, timeout=30) as response:
                body = response.read(); return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            if missing and error.code == 404: return None
            raise RuntimeError(f"MQ API {method} {path}: HTTP {error.code}") from None

    process = None
    try:
        with open(backup / "port-forward.log", "w") as log:
            process = subprocess.Popen(["kubectl", "-n", args.namespace, "port-forward", "service/aigc-mq", f"{args.local_port}:15672", "--address=127.0.0.1"], stdout=log, stderr=log)
            for attempt in range(75):
                if process.poll() is not None: raise RuntimeError("Port forward failed; inspect private backup log")
                try: api("GET", "overview"); break
                except (urllib.error.URLError, ConnectionError): time.sleep(0.2)
            else: raise RuntimeError("Management connection timed out")
            api("GET", "vhosts/" + quote(VHOST))  # Never create an accidental vhost.
            before = api("GET", "definitions")
            private_json(backup / "broker.before.json", before)
            existing_users = []
            for user in desired["users"]:
                existing = api("GET", "users/" + quote(user["name"]), missing=True)
                if existing:
                    if existing.get("hashing_algorithm") != "rabbit_password_hashing_sha256" or not matches_password(passwords[user["name"]], existing.get("password_hash", "")):
                        raise ValueError("Existing workflow account has a different password; refusing to rotate: " + user["name"])
                    if existing.get("tags"): raise ValueError("Existing workflow account has privileged tags: " + user["name"])
                    existing_users.append(user["name"])
            desired["users"] = [u for u in desired["users"] if u["name"] not in existing_users]
            for kind, checks in [("queues", ("durable", "auto_delete", "arguments")), ("exchanges", ("type", "durable", "auto_delete", "internal", "arguments"))]:
                for resource in desired[kind]:
                    old = api("GET", kind + "/" + quote(VHOST) + "/" + quote(resource["name"]), missing=True)
                    if old and any(old.get(k) != resource[k] for k in checks):
                        raise ValueError("Existing resource differs; refusing to recreate or delete: " + resource["name"])
            api("POST", "definitions", desired)  # Additive import; no delete operation.
            current = api("GET", "definitions")
            # Verify exact rights and effective resource configuration, not just HTTP success.
            for permission in topology()["permissions"]:
                actual = api("GET", "permissions/" + quote(VHOST) + "/" + quote(permission["user"]))
                if any(actual[k] != permission[k] for k in ("configure", "write", "read")): raise RuntimeError("Permission verification failed")
            for policy in desired["policies"]:
                actual = api("GET", "policies/" + quote(VHOST) + "/" + quote(policy["name"]))
                if actual["definition"] != policy["definition"]: raise RuntimeError("Queue policy verification failed")
            private_json(backup / "broker.after.json", current)
            merged = merge_definitions(original, current)
            patch = {"data": {"definitions.json": base64.b64encode(json.dumps(merged).encode()).decode()}}
            private_json(backup / "boot-definitions.patch.json", patch)
            kubectl(args.namespace, "patch", "secret", "aigc-mq-definitions", "--type=merge", "--patch-file", str(backup / "boot-definitions.patch.json"))
            if args.patch_api:
                values = {}
                for name, service, operation, key in [("CodeAudit", "code-audit", "review.requested", "code-audit.submit.v1"), ("Deployment", "deployment", "deploy.submit.v1", "deployment.submit.v1")]:
                    fields = {"Enabled": "true", "HostName": "aigc-mq", "Port": "5672", "VirtualHost": VHOST,
                        "UserName": RUNTIME, "Password": passwords[RUNTIME], "UseTls": "false", "Exchange": "aigc.workflow.commands",
                        "ResultQueue": f"aigc.workflow.{service}.results", f"RoutingKeys__{operation}": key}
                    values.update({f"IntegrationConnections__{name}__{k}": v for k, v in fields.items()})
                values["IntegrationConnections__CodeAudit__RoutingKeys__audit.submit.v1"] = "code-audit.submit.v1"
                patch = {"stringData": values}
                if args.patch_configmap:
                    settings_patch, patch = split_api_settings(values)
                    private_json(backup / "settings.patch.json", settings_patch)
                    kubectl(args.namespace, "patch", "configmap", "aigc-settings", "--type=merge", "--patch-file", str(backup / "settings.patch.json"))
                    # Secret envFrom wins over ConfigMap: remove only the keys just moved.
                private_json(backup / "api.patch.json", patch)
                kubectl(args.namespace, "patch", "secret", "aigc-secrets", "--type=merge", "--patch-file", str(backup / "api.patch.json"))
            print("Workflow topology verified; merged startup definitions persisted. No workloads restarted.")
            print("Private recovery files:", backup)
            print("In-cluster AMQP: aigc-mq.bosch-aigc-dsh.svc.cluster.local:5672; vhost /aigc")
            print("External AMQP: 172.28.2.33:30672 (existing NodePort; Service was not modified).")
    finally:
        if process is not None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()


if __name__ == "__main__":
    try: main()
    except Exception as error:
        raise SystemExit(f"Workflow provisioning stopped: {error}. Changes may be partial; inspect private recovery files before retry. No resources were deleted.")
