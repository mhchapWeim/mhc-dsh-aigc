# 第三方审计服务对接说明（MQ 协议）

> 本文保留本地模拟环境记录。生产接入以 [生产对接协议](AIGC-CODE-AUDIT-MQ-PRODUCTION.md) 为准：沿用 nj304 `/aigc`、独立服务账号和结果交换机，不使用本文本地默认账号或默认交换机发布方式。

本文档面向**第三方审计服务**的开发方，说明如何通过 RabbitMQ 与 AIGC 流程引擎对接：接收审计请求、回传审计结果。

> 文中字段、校验规则、限额均取自 AIGC 后端实现（`IntegrationWorkflowRunner.cs` / `IntegrationMqWorker.cs`），非约定推测。

---

## 1. 对接模型

AIGC 是**消息发起方**，审计服务是**消息处理方**。

```
AIGC 流程引擎                        审计服务
      │                                  │
      │ ① 发布审计请求                    │
      ├─────────────────────────────────>│ 消费 requests 队列
      │                                  │
      │                                  │ ② 执行审计
      │                                  │
      │ ③ 回传审计结果                    │
      │<─────────────────────────────────┤ 发布到 results 队列
      │                                  │
      ▼ 按结果推进流程                     │
```

**两条队列职责严格分离**：

| 队列 | 生产者 | 消费者 |
|---|---|---|
| `aigc.workflow.code-audit.requests` | AIGC | **审计服务** |
| `aigc.workflow.code-audit.results` | **审计服务** | AIGC |

> ⚠️ 不要把审计请求投到 results 队列。两者混淆会导致消息被当作错误格式丢弃，且流程永久卡住。

---

## 2. 连接信息

### 本地开发环境

| 项 | 值 |
|---|---|
| 协议 | AMQP 0-9-1 |
| 主机 | `localhost` |
| 端口 | `5672` |
| Virtual Host | `/` |
| 用户名 | `aigc` |
| 密码 | `aigc-dev` |
| TLS | 关闭 |
| 管理台 | http://localhost:15672 |

### 生产环境

由 AIGC 运维提供，**不要复用本地凭据**。生产要求：

- 独立 vhost（建议 `/aigc-workflow`）
- 独立账号，最小权限（仅 `read/write` 所需两条队列）
- 启用 TLS

凭据不通过本仓库分发，向对接负责人索取。

---

## 3. 队列拓扑

```
交换机 aigc.workflow.commands (direct, durable)
   │  routing key: code-audit.submit.v1
   ▼
队列 aigc.workflow.code-audit.requests (durable)
   │  ← 审计服务消费这里
   │
   │  审计服务处理完成后，把结果发布到：
   ▼
队列 aigc.workflow.code-audit.results (durable)
   │  ← AIGC 从这里拉取

失败消息（双方都无法处理时）进入：
交换机 aigc.workflow.dead-letter (fanout) → 队列 aigc.workflow.dead-letters
```

### 队列参数

| 队列 | durable | 说明 |
|---|---|---|
| `aigc.workflow.code-audit.requests` | true | 需预先声明 |
| `aigc.workflow.code-audit.results` | true | 需预先声明 |
| `aigc.workflow.dead-letters` | true | 排障用，无需消费 |

> **AIGC 不会自动创建这些队列**。代码中没有 `QueueDeclare`/`ExchangeDeclare`，拓扑由部署方预置。审计服务也**不应**自行声明，应由 AIGC 侧统一创建，避免参数冲突。

---

## 4. 审计请求格式（AIGC → 审计服务）

从 `aigc.workflow.code-audit.requests` 队列消费。

### 消息体

```json
{
  "schemaVersion": "1.0",
  "messageId": "0f9c8e1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  "serviceCode": "code-audit",
  "operationCode": "audit.submit.v1",
  "correlationId": "0f9c8e1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  "data": {
    "repositoryUrl": "https://git.example.com/org/app",
    "branch": "main",
    "commitSha": "6fc7d25ec48a15bf38083bfb40e6b9fded9898f3",
    "version": "1.0.0",
    "environment": "Test",
    "appName": "设备知识助手"
  }
}
```

### 字段说明

| 字段 | 类型 | 必有 | 说明 |
|---|---|---|---|
| `schemaVersion` | string | 是 | 固定 `"1.0"`，后续版本会递增 |
| `messageId` | string(uuid) | 是 | 请求唯一标识，当前等于调用记录 ID |
| `serviceCode` | string | 是 | 服务标识，固定 `code-audit` |
| `operationCode` | string | 是 | 操作编码，见下表 |
| `correlationId` | string(uuid) | 是 | **回传结果时必须原样带回**，AIGC 靠它定位调用 |
| `data` | object | 是 | 业务数据 |

### `operationCode` 取值

| 值 | 含义 | 期望的 `eventType` |
|---|---|---|
| `audit.submit.v1` | 代码审计 | `audit.completed.v1` |
| `deploy.submit.v1` | 部署应用 | `deploy.completed.v1` |

> `eventType` 必须与 `operationCode` 配对。**配对错误会被 403 拒绝**，见 §7。

### `data` 业务字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `repositoryUrl` | string | 仓库地址 |
| `branch` | string | 分支或标签名 |
| `commitSha` | string | 提交 SHA（40 位） |
| `version` | string | 发布版本号 |
| `environment` | string | `Test` / `Staging` / `Production` |
| `appName` | string | 应用名称 |

AIGC 支持通过流程节点的 `inputMappings` 裁剪字段，因此**不要假设这些字段一定全部存在**，按需读取即可。

### AMQP 消息属性

AIGC 投递时设置：

| 属性 | 值 |
|---|---|
| `delivery_mode` | `2`（持久化） |
| `content_type` | `application/json` |
| `message_id` | 同 `messageId` |
| `correlation_id` | 同 `correlationId` |
| `type` | 同 `operationCode` |

### 消费注意事项

- **必须手动 ACK**（`autoAck=false`），审计完成后再确认
- 消费前设置 `basic_qos(prefetch_count=1)`，避免一次拉太多
- 队列无 TTL，消息会一直保留到被消费

---

## 5. 审计结果格式（审计服务 → AIGC）

发布到 `aigc.workflow.code-audit.results` 队列。

### 发布方式

推荐使用**默认交换机**（exchange 为空字符串，routing key 填队列名）：

```python
channel.basic_publish(
    exchange="",
    routing_key="aigc.workflow.code-audit.results",
    body=json.dumps(result).encode(),
    properties=pika.BasicProperties(
        delivery_mode=2,
        content_type="application/json",
        message_id=result["messageId"],
        correlation_id=result["correlationId"],
    ),
)
```

> 结果队列**没有绑定任何交换机**，AIGC 是按队列名轮询拉取的。走默认交换机最直接。

### 场景一：审计通过

```json
{
  "messageId": "audit-20261112-001",
  "serviceCode": "code-audit",
  "eventType": "audit.completed.v1",
  "correlationId": "0f9c8e1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  "executionStatus": "Succeeded",
  "data": {
    "decision": "Passed",
    "commitSha": "6fc7d25ec48a15bf38083bfb40e6b9fded9898f3",
    "summary": "未发现阻断问题",
    "reportUrl": "https://audit.example.com/reports/42",
    "issues": []
  }
}
```

### 场景二：审计不通过

```json
{
  "messageId": "audit-20261112-002",
  "serviceCode": "code-audit",
  "eventType": "audit.completed.v1",
  "correlationId": "0f9c8e1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  "executionStatus": "Succeeded",
  "data": {
    "decision": "Rejected",
    "commitSha": "6fc7d25ec48a15bf38083bfb40e6b9fded9898f3",
    "summary": "存在 2 个高危依赖，必须升级后重新提交",
    "reportUrl": "https://audit.example.com/reports/43",
    "issues": ["High · 依赖 log4j 存在 RCE", "High · 硬编码凭据"]
  }
}
```

### 场景三：审计服务自身失败

用于「审计无法完成」而非「代码有问题」。区别很重要：`Rejected` 是业务结论，`Failed` 是服务异常。

```json
{
  "messageId": "audit-20261112-003",
  "serviceCode": "code-audit",
  "eventType": "audit.completed.v1",
  "correlationId": "0f9c8e1a-3b2d-4e5f-8a9b-1c2d3e4f5a6b",
  "executionStatus": "Failed",
  "data": {
    "commitSha": "6fc7d25ec48a15bf38083bfb40e6b9fded9898f3",
    "error": "扫描器连接超时"
  }
}
```

### 场景四：部署成功（`deploy.submit.v1`）

> ⚠️ 部署结果**不可带 `decision` 字段**，且必须有 `deploymentUrl`。

```json
{
  "messageId": "deploy-20261112-001",
  "serviceCode": "code-audit",
  "eventType": "deploy.completed.v1",
  "correlationId": "8a7b6c5d-4e3f-2a1b-9c8d-7e6f5a4b3c2d",
  "executionStatus": "Succeeded",
  "data": {
    "commitSha": "6fc7d25ec48a15bf38083bfb40e6b9fded9898f3",
    "deploymentUrl": "https://apps.example.com/device-assistant",
    "deployedAt": "2026-11-12T06:00:00Z"
  }
}
```

`deploymentUrl` 必须是 **HTTPS** 绝对地址，否则整个结果被拒。

---

## 6. 结果字段定义

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messageId` | string | 是 | 结果消息唯一 ID，≤200 字符。**重复的 messageId 会被幂等忽略** |
| `serviceCode` | string | 是 | 必须等于 `code-audit` |
| `eventType` | string | 是 | 见下方配对表 |
| `correlationId` | string(uuid) | 是 | 必须等于请求里的 `correlationId` |
| `executionStatus` | string | 是 | 仅 `Succeeded` 或 `Failed` |
| `data` | object | 是 | 业务结果，**必须是 JSON 对象**，不能是数组或字符串 |

### `eventType` 配对

| 请求的 `operationCode` | 结果必须用 `eventType` |
|---|---|
| `audit.submit.v1` | `audit.completed.v1` |
| `deploy.submit.v1` | `deploy.completed.v1` |

### `data` 字段（审计类）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `decision` | string | 是 | `Passed` 或 `Rejected`。大小写敏感 |
| `commitSha` | string | 视配置 | 节点开启 `verifyCommit` 时**必须**与请求一致 |
| `summary` | string | 否 | 结论摘要，展示给审核人 |
| `reportUrl` | string | 否 | 审计详情页地址，审核人点击查看 |
| `issues` | array | 否 | 问题列表，AIGC 取条数展示 |

**`reportUrl` 的重要性**：AIGC 的审核页面会把它渲染成「查看完整审计详情」链接，审核人据此判断是否通过。不提供则审核人只能盲审。

字段名兼容：`detailUrl` / `reportUrl` / `auditUrl` / `reportPageUrl` 均可识别。

### `data` 字段（部署类）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `deploymentUrl` | string | 是 | HTTPS 绝对地址，写入申请的访问地址 |
| `commitSha` | string | 视配置 | 同上 |
| `deployedAt` | string | 否 | ISO8601 时间戳 |

---

## 7. 校验规则（重要）

AIGC 收到结果后会逐项校验，任一失败则**拒绝并投入死信队列**，流程不推进。

| # | 校验 | 失败提示 | 状态码 |
|---|---|---|---|
| 1 | `serviceCode` 等于队列对应服务 | 结果来源或消息标识无效 | 403 |
| 2 | `messageId` 非空且 ≤200 字符 | 同上 | 403 |
| 3 | `data` 是 JSON 对象 | 结果 data 必须是对象 | — |
| 4 | `correlationId` 能找到调用记录 | 找不到调用记录 | 404 |
| 5 | `eventType` 等于该调用的 `ResultEvent` | 结果事件不匹配 | 403 |
| 6 | `executionStatus` ∈ {`Succeeded`,`Failed`} | 只接受最终执行结果 | — |
| 7 | `verifyCommit=true` 时 `commitSha` 与请求一致 | 结果 Commit 与申请不一致 | 409 |
| 8 | `decision` 只能是 `Passed`/`Rejected` | 审核结论无效 | — |
| 9 | 部署节点必须有 HTTPS `deploymentUrl` | 部署结果缺少有效的 HTTPS 地址 | — |
| 10 | 消息体 ≤ 256 KB | 结果消息过大 | — |

### 时序相关（不报错，但结果不生效）

| 情况 | 处理 | 记录为 |
|---|---|---|
| 同一 `messageId` 重复投递 | 幂等跳过 | 无记录 |
| 调用已完成（流程已推进） | 忽略 | `Stale` |
| 调用已超时（超过 `timeoutSeconds`） | 忽略 | `Expired` |

**这三种情况不会推进流程，但也不会报错**。审计服务应避免重复投递，并在超时前返回。

---

## 8. 可靠性与重试

### AIGC 侧投递重试

请求投递失败时 AIGC 会自动重试：

- 最大尝试次数由服务配置决定
- 退避策略：`2^attempts × 5` 秒，上限 300 秒
- 超过上限标记 `DeliveryFailed`，可在 AIGC 管理界面手动重试

### 审计服务侧建议

| 建议 | 理由 |
|---|---|
| 消费后先 ACK 再处理，或处理完再 ACK | 避免消息丢失；处理耗时长则用后者 |
| 用 `messageId` 做幂等 | 网络重投可能重复消费 |
| 在 `timeoutSeconds` 内返回 | 超时后结果被标记 `Expired`，白做 |
| 失败结果也要回传 `Failed` | 不回传则流程一直等到超时 |

`timeoutSeconds` 由流程节点配置，范围 **60–604800 秒**，默认 86400（24 小时）。审计服务可从对接方获知具体值，或按保守值（如 30 分钟）设计超时。

---

## 9. 死信队列（排障用）

无法处理的消息会进入 `aigc.workflow.dead-letters`，附带 AMQP 死信头：

```json
{
  "x-death": [{
    "count": 1,
    "queue": "aigc.workflow.code-audit.results",
    "reason": "rejected",
    "routing-keys": ["aigc.workflow.code-audit.results"],
    "time": 1794457046
  }],
  "x-first-death-reason": "rejected"
}
```

`reason` 取值：`rejected`（校验失败）、`expired`（TTL 到期）、`maxlen`（超出长度上限）。

**排查步骤**：

1. 在管理台查看 `aigc.workflow.dead-letters` 队列
2. 检查消息体的 `x-death.reason`
3. 对照 §7 的校验表定位问题字段

> 死信队列**没有消费者**，仅供人工查看。生产环境应配 TTL 和长度上限，避免无限堆积。

---

## 10. 联调自测清单

### 第一步：验证连接

```python
import pika
conn = pika.BlockingConnection(pika.ConnectionParameters(
    host="localhost", port=5672, virtual_host="/",
    credentials=pika.PlainCredentials("aigc", "aigc-dev")))
print("connected")
```

### 第二步：手工投递一条结果

```python
import json, pika, uuid

result = {
    "messageId": f"test-{uuid.uuid4()}",
    "serviceCode": "code-audit",
    "eventType": "audit.completed.v1",
    "correlationId": "<从请求消息里复制>",
    "executionStatus": "Succeeded",
    "data": {"decision": "Passed", "commitSha": "<从请求消息里复制>",
             "summary": "联调测试", "reportUrl": "https://example.com/report/1"},
}
channel.basic_publish(exchange="", routing_key="aigc.workflow.code-audit.results",
    body=json.dumps(result).encode(),
    properties=pika.BasicProperties(delivery_mode=2, content_type="application/json"))
```

### 第三步：确认 AIGC 已接收

- 死信队列应保持为空（有消息说明被拒，按 §7 查因）
- AIGC 流程节点应离开「代码审计」，进入下一个节点
- AIGC 审核页面应显示审计结论和详情链接

### 自测检查表

- [ ] 能连接 MQ 并消费 requests 队列
- [ ] 能从请求消息解析全部字段
- [ ] 回传的 `correlationId` 与请求一致
- [ ] `eventType` 与 `operationCode` 配对正确
- [ ] `executionStatus` 只用了 `Succeeded`/`Failed`
- [ ] 审计节点提供了 `reportUrl`
- [ ] `commitSha` 与请求一致（节点开启校验时）
- [ ] 部署结果不含 `decision`，且 `deploymentUrl` 是 HTTPS
- [ ] 消息体小于 256 KB

---

## 11. 常见错误对照

| 现象 | 原因 | 修正 |
|---|---|---|
| 流程一直停在「代码审计」 | 结果没投递或投错了队列 | 检查是否发到 results 队列 |
| 死信出现「结果事件不匹配」 | `eventType` 与 `operationCode` 不配对 | 见 §6 配对表 |
| 死信出现「结果 Commit 与申请不一致」 | `commitSha` 与请求不同 | 原样回传请求里的值 |
| 死信出现「审核结论无效」 | `decision` 拼写错误或大小写不对 | 只能 `Passed`/`Rejected` |
| 死信出现「结果 data 必须是对象」 | `data` 传了数组或字符串 | 改为 JSON 对象 |
| 流程走到「异常」分支 | 发了 `executionStatus=Failed` | 若代码实际通过，应发 `Succeeded`+`Passed` |
| 部署后申请没有访问地址 | 缺 `deploymentUrl` 或非 HTTPS | 补 HTTPS 绝对地址 |
| 结果投递了但流程没动 | 调用已超时或被判定 `Stale` | 检查返回时机与 `correlationId` |

---

## 12. 变更策略

| 项 | 承诺 |
|---|---|
| `schemaVersion` | 保持 `1.0`；不兼容变更时递增并在本文档标注 |
| 请求字段 | 只增不减；新增字段审计方应忽略未知字段 |
| `eventType` | 与 `operationCode` 的配对关系保持稳定 |
| 队列名称 | 保持稳定；如变更提前通知并提供并行期 |

**审计方实现建议**：解析 JSON 时忽略未知字段，不要对字段顺序、额外字段做严格校验。
