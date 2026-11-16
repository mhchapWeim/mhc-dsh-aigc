#!/usr/bin/env python3
"""Audit service simulator.

Consumes integration requests from RabbitMQ, waits a configurable delay, then
publishes an audit result back to the result queue so the AIGC workflow advances.

The message shapes mirror AigcHub.Api.Services.IntegrationResult / the outbox
payload built by IntegrationWorkflowRunner. Keep them in sync if the contract changes.

Usage:
  python audit_simulator.py                        # 80% pass, 10% reject, 10% fail
  python audit_simulator.py --decision reject      # always reject
  python audit_simulator.py --count 1 --delay 0    # handle just one, immediately
  python audit_simulator.py --dry-run              # print what would be sent
"""

from __future__ import annotations

import argparse
import json
import random
import signal
import sys
import time
import uuid
from review_contract import build_review_result
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    import pika
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("缺少依赖：请先执行 pip install pika")


@dataclass
class Config:
    host: str
    port: int
    vhost: str
    user: str
    password: str
    request_queue: str
    result_exchange: str
    result_routing_key: str
    result_queue: str
    event_types: dict[str, str]


DEFAULTS = Config(
    host="localhost",
    port=5672,
    vhost="/",
    user="aigc",
    password="aigc-dev",
    request_queue="aigc.workflow.code-audit.requests",
    result_exchange="",  # default exchange routes by queue name
    result_routing_key="aigc.workflow.code-audit.results",
    result_queue="aigc.workflow.code-audit.results",
    event_types={
        "audit.submit.v1": "audit.completed.v1",
        "deploy.submit.v1": "deploy.completed.v1",
    },
)


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def build_result(request: dict[str, Any], decision: str, config: Config, verdict: dict[str, Any]) -> dict[str, Any]:
    """Build an audit result that satisfies the workflow runner's validation rules.

    Rules enforced by the backend (IntegrationWorkflowRunner.ReceiveAsync):
      - serviceCode must match the trusted service of the queue being drained
      - eventType must equal the invocation's ResultEvent
      - correlationId must equal the invocation id
      - executionStatus is only "Succeeded" or "Failed"
      - when a node has verifyCommit=true, data.commitSha must equal the request commit
    """
    data = request.get("data") or {}
    base: dict[str, Any] = {
        "commitSha": data.get("commitSha"),
        "appName": data.get("appName"),
        "repositoryUrl": data.get("repositoryUrl"),
        "branch": data.get("branch"),
        "scannerVersion": verdict.get("scannerVersion", "aigc-audit-simulator/1.0"),
        "reportUrl": verdict.get("detailUrl") or f"https://audit.example.com/reports/{uuid.uuid4()}",
    }

    if decision == "fail":
        # A failed service run carries no business decision; the workflow takes the
        # "failed" branch (default exit) rather than a pass/reject verdict.
        return {
            "messageId": f"sim-{uuid.uuid4()}",
            "serviceCode": request["serviceCode"],
            "eventType": verdict["eventType"],
            "correlationId": request["correlationId"],
            "executionStatus": "Failed",
            "data": {
                **base,
                "error": verdict.get("error", "审计服务内部错误（模拟）"),
            },
        }

    base["decision"] = "Passed" if decision == "pass" else "Rejected"
    base["summary"] = verdict.get("summary", "未发现阻断问题" if decision == "pass" else "存在必须修复的问题")
    base["issues"] = verdict.get("issues", [])
    return {
        "messageId": f"sim-{uuid.uuid4()}",
        "serviceCode": request["serviceCode"],
        "eventType": verdict["eventType"],
        "correlationId": request["correlationId"],
        "executionStatus": "Succeeded",
        "data": base,
    }


def resolve_event_type(operation: str, config: Config, args: argparse.Namespace) -> str:
    """Echo the invocation's ResultEvent: audit and deploy operations differ."""
    if operation in config.event_types:
        return config.event_types[operation]
    return args.event_type


def build_deployment_result(request: dict[str, Any], verdict: dict[str, Any]) -> dict[str, Any]:
    """Deployment nodes must not carry decision; they need commitSha + an HTTPS url."""
    data = request.get("data") or {}
    return {
        "messageId": f"sim-{uuid.uuid4()}",
        "serviceCode": request["serviceCode"],
        "eventType": verdict["eventType"],
        "correlationId": request["correlationId"],
        "executionStatus": "Succeeded",
        "data": {
            "commitSha": data.get("commitSha"),
            "appName": data.get("appName"),
            "environment": data.get("environment"),
            "deploymentUrl": verdict.get("deploymentUrl", "https://apps.example.com/simulated-deploy"),
            "deployedAt": datetime.now(timezone.utc).isoformat(),
        },
    }


def pick_decision(mode: str, weights: tuple[float, float, float]) -> str:
    if mode != "mixed":
        return mode
    return random.choices(["pass", "reject", "fail"], weights=weights, k=1)[0]


def connect(config: Config) -> pika.BlockingConnection:
    parameters = pika.ConnectionParameters(
        host=config.host,
        port=config.port,
        virtual_host=config.vhost,
        credentials=pika.PlainCredentials(config.user, config.password),
        heartbeat=30,
        blocked_connection_timeout=10,
    )
    return pika.BlockingConnection(parameters)


def describe(request: dict[str, Any]) -> str:
    data = request.get("data") or {}
    return (
        f"{request.get('operationCode')} app={data.get('appName')!r} "
        f"ref={data.get('branch')} commit={(data.get('commitSha') or '')[:10]}"
    )


def run(config: Config, args: argparse.Namespace) -> int:
    weights = (args.pass_weight, args.reject_weight, args.fail_weight)
    event_type = args.event_type
    handled = 0
    stop = {"now": False}

    def handle_signal(_sig: int, _frame: Any) -> None:
        stop["now"] = True
        log("收到停止信号，处理完当前消息后退出…")

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    connection = connect(config)
    channel = connection.channel()
    channel.basic_qos(prefetch_count=1)
    channel.confirm_delivery()

    log(f"已连接 {config.host}:{config.port} vhost={config.vhost}")
    log(f"消费队列 {config.request_queue}")
    log(f"结果投递 {config.result_exchange or '(默认交换机)'} → {config.result_routing_key}")
    if args.dry_run:
        log("当前为 dry-run：只打印，不投递结果")

    def on_message(ch: Any, method: Any, properties: Any, body: bytes) -> None:
        nonlocal handled
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            log(f"跳过无法解析的消息 ({len(body)} 字节)，直接确认")
            ch.basic_ack(method.delivery_tag)
            return

        review_contract = request.get("event_type") == "review.requested"
        operation = request.get("operationCode", "")
        # Deployment and audit operations report different ResultEvents; echo whichever
        # this invocation expects, otherwise the backend rejects it as 结果事件不匹配.
        event_type = resolve_event_type(operation, config, args)
        # A deployment request is recognised by its operation code; the simulator
        # answers it with a deployment result instead of an audit verdict.
        verdict: dict[str, Any] = {
            "eventType": event_type,
            "scannerVersion": "aigc-audit-simulator/1.0",
            "issues": [] if args.decision == "pass" else [{"id": "DEP-001", "severity": "High", "title": "模拟阻断问题"}],
            "summary": "模拟审计结论",
            "deploymentUrl": args.deployment_url,
            "detailUrl": args.detail_url,
        }

        is_deployment = "deploy" in operation.lower()
        if review_contract:
            decision = pick_decision(args.decision, weights)
            result = build_review_result(request, decision, args.detail_url)
            label = decision
        elif is_deployment:
            result = build_deployment_result(request, verdict)
            label = "deploy-ok"
        else:
            decision = pick_decision(args.decision, weights)
            result = build_result(request, decision, config, verdict)
            label = decision

        log(f"收到请求 [{label}] {describe(request)}")

        if args.delay > 0:
            log(f"  模拟处理中，等待 {args.delay}s…")
            time.sleep(args.delay)

        if not args.dry_run:
            message_id = result.get("event_id") or result.get("messageId")
            correlation_id = result.get("request_id") or result.get("correlationId")
            result_event = result.get("event_type") or result.get("eventType")
            ch.basic_publish(
                exchange=config.result_exchange,
                routing_key=result_event if review_contract and config.result_exchange else config.result_routing_key,
                body=json.dumps(result, ensure_ascii=False).encode(),
                properties=pika.BasicProperties(
                    delivery_mode=2,
                    content_type="application/json",
                    content_encoding="utf-8",
                    message_id=message_id,
                    correlation_id=correlation_id,
                    type=result_event,
                    timestamp=int(datetime.fromisoformat(result["finished_at"]).timestamp()) if review_contract else int(time.time()),
                ),
                mandatory=True,
            )
            log(f"  已投递结果 messageId={message_id} status={result.get('status') or result.get('executionStatus')}")
        else:
            log(f"  [dry-run] {json.dumps(result, ensure_ascii=False)[:220]}")

        ch.basic_ack(method.delivery_tag)
        handled += 1
        if args.count and handled >= args.count:
            log(f"已达到目标条数 {args.count}，停止消费")
            stop["now"] = True

    channel.basic_consume(queue=config.request_queue, on_message_callback=on_message, auto_ack=False)
    log("开始消费（Ctrl+C 退出）")

    while not stop["now"]:
        connection.process_data_events(time_limit=1)

    channel.cancel()
    channel.close()
    connection.close()
    log(f"共处理 {handled} 条请求")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="AIGC 审计服务模拟器")
    parser.add_argument("--host", default=DEFAULTS.host)
    parser.add_argument("--port", type=int, default=DEFAULTS.port)
    parser.add_argument("--vhost", default=DEFAULTS.vhost)
    parser.add_argument("--user", default=DEFAULTS.user)
    parser.add_argument("--password", default=DEFAULTS.password)
    parser.add_argument("--request-queue", default=DEFAULTS.request_queue, help="消费的请求队列")
    parser.add_argument("--result-exchange", default=DEFAULTS.result_exchange, help="结果交换机，空表示默认交换机")
    parser.add_argument("--result-routing-key", default=DEFAULTS.result_routing_key)
    parser.add_argument("--event-type", default="audit.completed.v1", help="必须与服务的 ResultEvent 一致")
    parser.add_argument("--decision", choices=["mixed", "pass", "reject", "fail", "warning", "needs-review", "cancel", "request-rejected"], default="mixed",
                        help="模拟审计结论；mixed 按权重随机")
    parser.add_argument("--pass-weight", type=float, default=0.8)
    parser.add_argument("--reject-weight", type=float, default=0.1)
    parser.add_argument("--fail-weight", type=float, default=0.1)
    parser.add_argument("--delay", type=float, default=5.0, help="模拟处理耗时（秒）")
    parser.add_argument("--count", type=int, default=0, help="处理 N 条后退出，0 表示常驻")
    parser.add_argument("--deployment-url", default="https://apps.example.com/simulated-deploy")
    parser.add_argument("--detail-url", default="", help="审计详情页地址；留空则随机生成")
    parser.add_argument("--dry-run", action="store_true", help="只打印结果，不投递")
    args = parser.parse_args()

    return run(
        Config(
            host=args.host,
            port=args.port,
            vhost=args.vhost,
            user=args.user,
            password=args.password,
            request_queue=args.request_queue,
            result_exchange=args.result_exchange,
            result_routing_key=args.result_routing_key,
            result_queue=DEFAULTS.result_queue,
            event_types=DEFAULTS.event_types,
        ),
        args,
    )


if __name__ == "__main__":
    raise SystemExit(main())
