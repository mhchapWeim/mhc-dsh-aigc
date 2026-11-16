"""Summarize reported request usage from a DSH JSONL or exported session ZIP."""
import argparse
import collections
import json
from pathlib import Path
import zipfile


def read_events(path):
    path = Path(path)
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            files = [name for name in archive.namelist() if name.endswith(".jsonl")]
            if len(files) != 1:
                raise ValueError("Expected exactly one JSONL session in the ZIP")
            with archive.open(files[0]) as stream:
                return [json.loads(line) for line in stream if line.strip()]
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def summarize(events, turn=None, warn_tokens=None):
    requests = {}
    missing = 0
    tools = collections.Counter()
    largest = []
    for index, event in enumerate(events):
        kind = event.get("type")
        data = event.get("data", {})
        if turn is not None and data.get("turn") != turn:
            continue
        if kind == "tool/call":
            tools[data["name"]] += 1
        if kind == "tool/result":
            size = sum(len(block.get("text", "")) for block in data.get("message", {}).get("content", []))
            largest.append({"seq": event.get("seq"), "turn": data.get("turn"),
                            "step": data.get("step"), "text_chars": size})
        if kind not in ("assistant/message", "assistant/attempt", "compaction/summary"):
            continue
        usage = data.get("usage")
        identity = data.get("message", {}).get("source", {}).get("replayState", {}).get("response", {}).get("responseId")
        for item in data.get("stream", []):
            chunk = item.get("chunk", {})
            if chunk.get("type") == "usage" and data.get("usage") is None:
                usage = chunk["usage"]
            if chunk.get("type") == "finish":
                identity = chunk.get("replayState", {}).get("response", {}).get("responseId", identity)
        if usage is None:
            missing += 1
            continue
        for name, value in usage.items():
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ValueError(f"Invalid usage count: {name}")
        # Only the terminal sample is used, never its per-delta stream copies.
        key = identity or f"event:{event.get('seq', index)}"
        requests[key] = {"turn": data.get("turn"), "step": data.get("step"), "usage": usage,
                         "kind": "summary" if kind == "compaction/summary" else "main"}
    totals = collections.Counter()
    turns = {}
    for request in requests.values():
        usage = request["usage"]
        exact = usage.get("totalTokens")
        if exact is None:
            exact = sum(usage.get(name, 0) for name in ("inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"))
        buckets = {"input": usage.get("inputTokens", 0), "cache_read": usage.get("cacheReadTokens", 0),
                   "cache_write": usage.get("cacheWriteTokens", 0), "output": usage.get("outputTokens", 0),
                   "reported_total": exact}
        totals.update(buckets)
        group = turns.setdefault(str(request["turn"]), {"requests": 0, "reported_total": 0, "max_prompt": 0})
        group["requests"] += 1
        group["reported_total"] += exact
        group["max_prompt"] = max(group["max_prompt"], exact - usage.get("outputTokens", 0))
    return {"requests_with_usage": len(requests), "settlements_without_usage": missing,
            "totals": dict(totals), "turns": turns, "tools": dict(tools),
            "largest_tool_results": sorted(largest, key=lambda item: item["text_chars"], reverse=True)[:5],
            "warning_threshold_exceeded": warn_tokens is not None and totals["reported_total"] >= warn_tokens,
            "limits": "Reported samples only, including cache reads. Unlogged requests and missing usage are not inferred. This is not an authoritative billing statement."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--turn", type=int)
    parser.add_argument("--warn-tokens", type=int)
    args = parser.parse_args()
    if args.warn_tokens is not None and args.warn_tokens < 1:
        parser.error("--warn-tokens must be positive")
    print(json.dumps(summarize(read_events(args.session), args.turn, args.warn_tokens), ensure_ascii=False))


if __name__ == "__main__":
    main()
