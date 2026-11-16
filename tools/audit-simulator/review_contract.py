"""Test response builder for the 2026-11-12 review contract; not a real scanner."""
from datetime import datetime, timezone
import uuid


def build_review_result(request, decision, detail_url=""):
    task_id = str(uuid.uuid4())
    status = {"fail": "Failed", "cancel": "Cancelled", "request-rejected": "Rejected"}.get(decision, "Completed")
    verdict = {"pass": "Passed", "reject": "Failed", "warning": "Warning", "needs-review": "Needs Review"}.get(decision)
    registered = status != "Rejected"
    return {
        "event_id": str(uuid.uuid4()), "event_type": "review.finished" if registered else "review.rejected",
        "request_id": request["request_id"], "request_message_id": request["message_id"],
        "workflow_id": request["workflow_id"] if registered else None,
        "task_id": task_id if registered else None, "reviewer_subject": request["reviewer_subject"] if registered else None,
        "repository": request["repository"] if registered else None, "status": status,
        "verdict": verdict if status == "Completed" else None,
        "result": ("High" if decision == "reject" else verdict) if status == "Completed" else None,
        "review_url": (detail_url or f"https://review.example.com/reviews/{task_id}") if registered else None,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "error": {"code": "DEPENDENCY_UNAVAILABLE" if registered else "REPOSITORY_UNAVAILABLE", "message": "模拟审查错误", "retryable": registered, "details": []} if status in ("Failed", "Rejected") else None,
    }
