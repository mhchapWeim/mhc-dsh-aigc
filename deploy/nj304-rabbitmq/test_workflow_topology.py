import importlib.util
import json
from pathlib import Path
import re
import unittest
from workflow_topology import topology, matches_password, RUNTIME

spec = importlib.util.spec_from_file_location("configure_workflow", Path(__file__).with_name("configure-workflow.py"))
configure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure)


class WorkflowTopologyTests(unittest.TestCase):
    def test_review_results_and_rejections_both_route_without_removing_legacy_binding(self):
        keys = {b["routing_key"] for b in topology()["bindings"] if b["destination"] == "aigc.workflow.code-audit.results"}
        self.assertEqual(keys, {"audit.completed.v1", "review.finished", "review.rejected"})

    def test_review_results_and_rejections_both_route_without_removing_legacy_binding(self):
        keys = {b["routing_key"] for b in topology()["bindings"] if b["destination"] == "aigc.workflow.code-audit.results"}
        self.assertEqual(keys, {"audit.completed.v1", "review.finished", "review.rejected"})

    def test_only_workflow_resources_and_existing_vhost_are_used(self):
        data = topology()
        self.assertEqual(data["vhosts"], [{"name": "/aigc"}])
        self.assertEqual(len(data["queues"]), 5)
        self.assertTrue(all(q["name"].startswith("aigc.workflow.") and q["arguments"]["x-queue-type"] == "quorum" for q in data["queues"]))

    def test_third_party_cannot_publish_deployment_results_or_read_other_queues(self):
        permission = next(p for p in topology()["permissions"] if p["user"] == "aigc_code_audit")
        self.assertRegex("aigc.workflow.code-audit.results", permission["write"])
        self.assertIsNone(re.match(permission["write"], "aigc.workflow.deployment.results"))
        self.assertIsNone(re.match(permission["write"], ""))
        self.assertIsNone(re.match(permission["read"], "aigc.workflow.code-audit.results"))
        self.assertEqual(permission["configure"], "^$")

    def test_live_and_dead_queues_have_bounded_retention_and_reliable_dead_lettering(self):
        live, dead = topology()["policies"]
        self.assertEqual(live["definition"]["overflow"], "reject-publish")
        self.assertEqual(live["definition"]["dead-letter-strategy"], "at-least-once")
        self.assertGreater(dead["definition"]["message-ttl"], live["definition"]["message-ttl"])
        self.assertNotIn("dead-letter-exchange", dead["definition"])

    def test_passwords_are_salted_hashes_and_never_in_definitions(self):
        secret = "workflow-test-password-123456"
        data = topology({u: secret for u in [RUNTIME, "aigc_code_audit", "aigc_deployment"]})
        self.assertNotIn(secret, json.dumps(data))
        self.assertTrue(all(matches_password(secret, u["password_hash"]) for u in data["users"]))
        self.assertEqual(len({u["password_hash"] for u in data["users"]}), 3)

    def test_persistent_boot_merge_keeps_existing_users_and_latest_live_settings(self):
        saved = {"users": [{"name": "old", "password_hash": "old"}], "queues": [{"vhost": "/aigc", "name": "existing", "durable": True}]}
        live = {"users": [{"name": "old", "password_hash": "rotated"}, {"name": RUNTIME}], "queues": topology()["queues"]}
        merged = configure.merge_definitions(saved, live)
        self.assertEqual(len(merged["users"]), 2)
        self.assertEqual(merged["users"][0]["password_hash"], "rotated")
        self.assertEqual(len(merged["queues"]), 6)


if __name__ == "__main__": unittest.main()
