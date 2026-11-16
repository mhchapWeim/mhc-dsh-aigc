import unittest
import uuid
from datetime import datetime
from review_contract import build_review_result


class ReviewContractTests(unittest.TestCase):
    def test_terminal_messages_have_complete_correlation_and_correct_null_semantics(self):
        request = {"message_id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()), "workflow_id": str(uuid.uuid4()),
                   "reviewer_subject": "employee001", "repository": {"full_name": "team/app", "commit_sha": "a" * 40}}
        for decision in ("pass", "reject", "warning", "needs-review", "fail", "cancel", "request-rejected"):
            with self.subTest(decision=decision):
                result = build_review_result(request, decision)
                self.assertEqual(result["request_id"], request["request_id"])
                self.assertEqual(result["request_message_id"], request["message_id"])
                uuid.UUID(result["event_id"])
                self.assertIsNotNone(datetime.fromisoformat(result["finished_at"]).tzinfo)
                self.assertEqual(len(result), 14)
                if decision == "request-rejected":
                    self.assertEqual(result["event_type"], "review.rejected")
                    self.assertIsNone(result["task_id"])
                    self.assertIsNone(result["review_url"])
                else:
                    self.assertEqual(result["event_type"], "review.finished")
                    self.assertEqual(result["repository"], request["repository"])
                if result["status"] == "Completed":
                    self.assertIsNone(result["error"])
                    self.assertIsNotNone(result["verdict"])
                else:
                    self.assertIsNone(result["verdict"])
                    self.assertIsNone(result["result"])


if __name__ == "__main__": unittest.main()
