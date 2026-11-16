# 审计服务模拟器

模拟代码审计 / 部署第三方服务：从 RabbitMQ 消费 AIGC 流程发来的请求，等待一段时间后把结果投回结果队列，驱动流程自动流转。

2026-11-12：已同时支持原 generic-v1 和审计方 snake_case 协议。新协议请求 `event_type=review.requested` 时自动生成 `review.finished/review.rejected`，并提供完整 AMQP 属性、Publisher Confirms 和 mandatory。新协议请指定 `--result-exchange aigc.workflow.code-audit.results`，结果 routing key 自动采用 event_type。

新协议额外支持 `--decision warning`、`needs-review`、`cancel`、`request-rejected`；原 `reject` 表示 `Completed + verdict=Failed`，并非登记任务前拒绝。本工具仅用于隔离开发测试，没有真实扫描或持久化幂等能力，不应连接生产队列。

## 依赖

```bash
python -m pip install pika
```

## 前置条件

本地需要三样东西（AIGC 侧不会自动创建）：

| 资源 | 名称 |
|---|---|
| 交换机 | `aigc.workflow.commands`（direct, durable） |
| 请求队列 | `aigc.workflow.code-audit.requests`（本模拟器消费） |
| 结果队列 | `aigc.workflow.code-audit.results`（AIGC 拉取） |

绑定：`aigc.workflow.commands --[code-audit.submit.v1]--> aigc.workflow.code-audit.requests`

服务端配置（`appsettings.Development.json`）需包含路由键，否则投递会静默失败：

```json
"CodeAudit": {
  "Exchange": "aigc.workflow.commands",
  "ResultQueue": "aigc.workflow.code-audit.results",
  "RoutingKeys": {
    "audit.submit.v1": "code-audit.submit.v1",
    "deploy.submit.v1": "code-audit.submit.v1"
  }
}
```

## 用法

```bash
# 常驻，默认 80% 通过 / 10% 退回 / 10% 失败，处理耗时 5 秒
python audit_simulator.py

# 只处理一条，立即返回通过
python audit_simulator.py --count 1 --delay 0 --decision pass

# 全部退回 / 全部失败
python audit_simulator.py --decision reject
python audit_simulator.py --decision fail

# 只看结果不投递（调试消息体）
python audit_simulator.py --count 1 --dry-run

# 自定义权重与部署地址
python audit_simulator.py --pass-weight 0.5 --reject-weight 0.3 --fail-weight 0.2 \
  --deployment-url https://apps.example.com/my-app
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--decision` | `mixed` | `mixed` / `pass` / `reject` / `fail` |
| `--count` | `0` | 处理 N 条后退出，0 = 常驻 |
| `--delay` | `5` | 模拟处理耗时（秒） |
| `--request-queue` | `aigc.workflow.code-audit.requests` | 消费队列 |
| `--result-routing-key` | `aigc.workflow.code-audit.results` | 结果路由键 |
| `--event-type` | `audit.completed.v1` | 未在映射表中命中时的兜底事件 |
| `--dry-run` | 关 | 只打印，不投递 |

连接参数：`--host` / `--port` / `--vhost` / `--user` / `--password`，默认对齐本地配置（`aigc` / `aigc-dev`）。

## 结果消息契约

模拟器生成的消息必须满足后端 `IntegrationWorkflowRunner.ReceiveAsync` 的校验：

- `serviceCode` 必须与队列对应的服务一致
- `eventType` 必须等于该调用记录的 `ResultEvent`（审计与部署不同，见映射表）
- `correlationId` 必须是调用记录 ID
- `executionStatus` 只能是 `Succeeded` / `Failed`
- 节点开启 `verifyCommit` 时，`data.commitSha` 必须与申请一致

### 审计节点的结果

```json
{
  "executionStatus": "Succeeded",
  "data": { "decision": "Passed", "commitSha": "...", "issues": [] }
}
```

`decision` 决定分支：`Passed` → `passed`，`Rejected` → `rejected`。

### 部署节点的结果

**不能带 `decision`**，否则会算出 `passed` 而部署节点没有该出口，直接坠入失败分支：

```json
{
  "executionStatus": "Succeeded",
  "data": { "commitSha": "...", "deploymentUrl": "https://..." }
}
```

`deploymentUrl` 必须为 HTTPS——流程走到「发布完成」时会强制校验访问地址。

## 已知约束

- 流程图若在审计通过后**直接连到 Approved 结束节点**，会因缺少部署地址被拒绝。审计通过后必须先经过部署节点
- 请求与结果必须是两条独立队列。把命令交换机绑到结果队列会导致请求被当作结果消息丢弃
