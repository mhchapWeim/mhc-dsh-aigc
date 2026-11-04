import importlib.util
import json
import re
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("config_topology", Path(__file__).with_name("prepare-config-sync.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigTopologyTests(unittest.TestCase):
    def test_credentials_are_hashed_and_existing_users_are_not_replaced(self):
        secret = "test-config-only-20261103"
        output = module.definition(secret)
        self.assertNotIn(secret, json.dumps(output))
        self.assertEqual([u["name"] for u in output["users"]], ["aigc_config_runtime"])
        self.assertEqual(output["users"][0]["tags"], "")
        self.assertEqual(output["exchanges"][0]["name"], "aigc.config.events")

    def test_permissions_allow_only_config_exchange_and_instance_queues(self):
        permission = module.definition("test-config-only-20261103")["permissions"][0]
        queue = "aigc.config.api." + "a" * 32
        self.assertIsNotNone(re.fullmatch(permission["configure"], queue))
        self.assertIsNone(re.fullmatch(permission["configure"], "aigc.config.events"))
        for operation in ("read", "write"):
            self.assertIsNotNone(re.fullmatch(permission[operation], queue))
            self.assertIsNotNone(re.fullmatch(permission[operation], "aigc.config.events"))
            self.assertIsNone(re.fullmatch(permission[operation], "aigc.identity.users"))
            self.assertIsNone(re.fullmatch(permission[operation], "aigc.users.service-1"))
        with self.assertRaises(ValueError):
            module.definition("short")


if __name__ == "__main__":
    unittest.main()
