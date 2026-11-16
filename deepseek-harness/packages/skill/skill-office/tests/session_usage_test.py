import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("session_usage", Path(__file__).parents[1] / "assets/scripts/session_usage.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UsageTests(unittest.TestCase):
    def test_counts_terminal_usage_once_and_includes_failed_attempts_and_cache(self):
        usage = {"inputTokens": 10, "cacheReadTokens": 100, "outputTokens": 5, "totalTokens": 115}
        events = [
            {"type": "assistant/message", "seq": 1, "data": {"turn": 1, "step": 1, "usage": usage,
             "stream": [{"chunk": {"type": "usage", "usage": usage}}]}},
            {"type": "assistant/attempt", "seq": 2, "data": {"turn": 1, "step": 2,
             "stream": [{"chunk": {"type": "usage", "usage": usage}}]}},
            {"type": "assistant/attempt", "seq": 3, "data": {"turn": 1, "step": 3, "stream": []}},
        ]
        report = MODULE.summarize(events, warn_tokens=200)
        self.assertEqual(report["totals"]["reported_total"], 230)
        self.assertEqual(report["totals"]["cache_read"], 200)
        self.assertEqual(report["settlements_without_usage"], 1)
        self.assertTrue(report["warning_threshold_exceeded"])
        self.assertEqual(MODULE.summarize(events, turn=2)["requests_with_usage"], 0)

    def test_same_response_id_replaces_a_duplicate_settlement(self):
        event = {"type": "assistant/message", "data": {"turn": 1, "step": 1,
                 "usage": {"inputTokens": 3, "outputTokens": 1, "totalTokens": 4},
                 "message": {"source": {"replayState": {"response": {"responseId": "same"}}}}}}
        self.assertEqual(MODULE.summarize([event, event])["totals"]["reported_total"], 4)


if __name__ == "__main__":
    unittest.main()
