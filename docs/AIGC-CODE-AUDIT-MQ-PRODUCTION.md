# AIGC 与第三方代码审计服务生产对接协议

> 代码审查业务已按审计方简化版调整为 snake_case，请以 [2026-11-12 接入与切换说明](AIGC-CODE-REVIEW-CONTRACT-20261112.md) 为准。本文保留基础设施和旧调用说明，原审计请求/结果 JSON 仅适用于 generic-v1 旧协议。

版本：2026-11-12 / schemaVersion 1.0。目标：nj304 现有 RabbitMQ 4.2，沿用 `/aigc`，隔离本业务账号与资源。本文为生产对接依据；不使用本地模拟环境账号。

## 1. 连接信息

| 项目 | 值 |
| --- | --- |
| Kubernetes 命名空间 | `bosch-aigc-dsh` |
| RabbitMQ 所在节点 | `bosch-k8s-node-nj304`（手册地址 `172.28.2.33`，部署前现场核对） |
| 集群内主机 | `aigc-mq.bosch-aigc-dsh.svc.cluster.local` |
| 集群内端口 | `5672` |
| Virtual host | `/aigc`；URI 中编码为 `%2Faigc` |
| AMQP | AMQP 0-9-1 |
| 审计服务账号 | `aigc_code_audit`，密码由运维独立安全交付 |
| API 运行账号 | `aigc_workflow_runtime`，不得交给第三方 |
| 部署服务账号 | `aigc_deployment`，不得交给审计服务 |
| 集群外地址 | `172.28.2.33:30672`（2026-11-12 用户现场查询确认） |
| TLS | 现有部署材料为明文 AMQP；只在受控内网、按来源放行。需要 TLS 时由运维另行配置证书及 AMQPS 监听，不能仅修改客户端端口假设已支持 |

现有 `aigc-mq` 为 NodePort：AMQP `5672→30672`，管理接口 `15672→30242`，`externalTrafficPolicy=Cluster`；Pod 位于 nj304。旧 YAML 和 last-applied annotation 仍为 ClusterIP，不能据此覆盖现场 Service。本次不修改 Service，不新建 NodePort。管理接口虽已有外部映射，也不向第三方提供管理凭据或用作业务接口；运维应按来源控制网络访问。

## 2. 拓扑与权限

| 方向 | 发布交换机（direct / durable） | Routing key | 消费队列（durable / quorum） |
| --- | --- | --- | --- |
| AIGC → 审计 | `aigc.workflow.commands` | `code-audit.submit.v1` | `aigc.workflow.code-audit.requests` |
| 审计 → AIGC | `aigc.workflow.code-audit.results` | `audit.completed.v1` | `aigc.workflow.code-audit.results` |
| AIGC → 部署 | `aigc.workflow.commands` | `deployment.submit.v1` | `aigc.workflow.deployment.requests` |
| 部署 → AIGC | `aigc.workflow.deployment.results` | `deploy.completed.v1` | `aigc.workflow.deployment.results` |

交换机和结果队列同名是刻意约定，二者为不同资源。审计方只读审计请求队列，只写审计结果交换机，无 configure 权限。**不能通过默认交换机 `exchange=""` 发布结果**，不能访问部署队列，也不能自己声明队列、交换机、绑定。

全部拓扑由运维预置。第三方客户端需关闭自动声明与自动创建拓扑，但可重新连接并重新开始消费。

## 3. 请求协议

AMQP 属性：`content_type=application/json`、UTF-8、`delivery_mode=2`、`message_id=correlation_id=调用UUID`、`type=audit.submit.v1`。消息体：

```json
{
  "schemaVersion": "1.0",
  "messageId": "a758ab75-bc11-44f1-823c-536794d1cbf1",
  "serviceCode": "code-audit",
  "operationCode": "audit.submit.v1",
  "correlationId": "a758ab75-bc11-44f1-823c-536794d1cbf1",
  "data": {
    "repositoryUrl": "https://git.boschhuayu-steering.com/team/application",
    "branch": "main",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "version": "1.0.0",
    "environment": "Production",
    "appName": "应用名称"
  }
}
```

`correlationId` 识别一次节点执行；发送重试沿用同一个 ID，申请重新提交会产生新 ID。审计必须针对完整 Commit 拉取代码，不能拉取最新分支头代替指定版本。仓库读取使用审计方自己的受限机器账号，本消息不包含申请人的 Gitea Token。

业务字段由流程节点映射决定，默认发送上表六个字段；上线流程必须保留审计所需的 repositoryUrl、commitSha。未知的可选字段应忽略；未知 schemaVersion/operationCode 应记录并隔离，不按猜测执行。

## 4. 结果协议

审计服务将以下 JSON 发布到结果交换机及路由键，不直接向队列写入。AMQP 开启持久化、publisher confirms 和 mandatory，得到确认后才能标记“结果已发送”。结果体 `messageId` 是第三方生成的稳定唯一事件 ID，可与调用 ID 不同；重发同一结果必须保持该事件 ID 不变。

### 审计通过

```json
{
  "messageId": "audit-result-20261112-000001",
  "serviceCode": "code-audit",
  "eventType": "audit.completed.v1",
  "correlationId": "a758ab75-bc11-44f1-823c-536794d1cbf1",
  "executionStatus": "Succeeded",
  "data": {
    "decision": "Passed",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "summary": "代码审计通过",
    "issueCount": 0,
    "reportUrl": "https://audit.example.com/reports/000001",
    "externalTaskId": "audit-000001"
  }
}
```

### 审计拒绝

`executionStatus` 仍为 `Succeeded`，`data.decision=Rejected`，并返回原 commitSha、summary、issueCount、reportUrl。这表示审计完成，但代码不满足发布要求。

### 服务执行失败

```json
{
  "messageId": "audit-result-20261112-000002",
  "serviceCode": "code-audit",
  "eventType": "audit.completed.v1",
  "correlationId": "a758ab75-bc11-44f1-823c-536794d1cbf1",
  "executionStatus": "Failed",
  "data": { "summary": "无法读取指定仓库", "errorCode": "REPOSITORY_UNAVAILABLE" }
}
```

失败结果不要求 commitSha。服务暂时故障可在第三方内部重试，最终无法完成再回 Failed；不要用 Rejected 表示服务崩溃。不接受 Running/Queued 等中间状态推进流程。

## 5. 校验和展示

- 顶层字段名按示例；值区分大小写，`executionStatus` 仅 `Succeeded/Failed`。
- `messageId` 非空，最多 200 字符；`correlationId` 必须是请求中的 UUID。
- `serviceCode` 必须匹配队列绑定的服务，`eventType` 必须匹配调用快照。
- `data` 必须是 JSON 对象。审计成功必须包含 `decision=Passed/Rejected`；启用 Commit 校验的节点必须回传一致的 commitSha。
- 消息正文最多 **256 KiB**，详细报告保存在审计服务，通过 HTTPS reportUrl 引用，不把完整扫描日志发回 MQ。
- AIGC 审核详情展示 decision、summary、issueCount、commitSha 和报告链接；兼容 detailUrl/auditUrl/reportPageUrl，但新对接统一用 reportUrl。
- 第三方只报告结果，不能指定下一流程节点或修改申请权限。是否继续由已发布流程定义决定。
- 审计通过不等于应用已发布。后续仍需部署审批与部署结果。部署结果使用独立 serviceCode `deployment`、事件 `deploy.completed.v1`，含 HTTPS deploymentUrl 和原 commitSha；部署节点以执行状态路由，附带 decision 不会将它改为审计分支。

## 6. 幂等、ACK、重试

推荐第三方实现：

1. 手动 ACK 消费请求，先将 `(serviceCode,correlationId)` 唯一任务持久化；事务提交后 ACK。
2. 重复请求查找原任务，执行中不重复扫描，已完成则安排重发原结果。
3. 审计任务完成后将结果与发送 Outbox 同事务提交。
4. 后台发送结果，收到 publisher confirm 后标记已发送；连接中断时允许重发同一结果。

如果直接同步处理，则必须在结果持久化并确认发布后 ACK，不能一接到请求就 ACK。业务失败回传 Failed 后正常 ACK；格式或版本不可处理时 reject/nack(requeue=false) 进入死信。临时故障需有退避与上限，禁止无限立即 requeue。

AIGC 发出请求最多自动投递 5 次，指数退避，发布确认丢失时仍可能重复投递；管理员可重试投递，沿用调用 ID。AIGC 以 `(serviceCode,messageId)` 去重；结果提交数据库事务后才 ACK。已完成、取消或旧调用结果记为 Stale；超期结果记为 Expired，不推进。超时由节点配置，默认 24 小时，可配置 60 秒至 7 天，队列 TTL 不代替业务超时。

## 7. 队列保留与死信

四条业务队列：TTL **7 天**，每队列最多 **10,000 条 / 256 MiB**，满时 reject-publish，quorum delivery-limit=20，使用 at-least-once 死信转发。

死信：`aigc.workflow.dead-letter`（fanout）→ `aigc.workflow.dead-letters`（quorum）；TTL **14 天**，10,000 条 / 256 MiB，reject-publish。无死信回环，不自动重放。死信满会导致源队列积压，需监控并由运维清理或归档。TTL、长度上限及单节点磁盘故障意味着这不是永久归档或多节点高可用。

## 8. 联调验收

1. 取得独立审计账号后，确认可消费审计请求、可确认发布审计结果；不能读取结果队列、部署请求或发布部署结果。
2. 申请固定 Commit，确认收到 operationCode=audit.submit.v1 的请求。
3. 分别返回 Passed、Rejected、Failed，确认三种流程走向符合定义。
4. 相同 messageId 重发两次，只推进一次；同调用第二个结果 ID 也不能重复创建人工任务。
5. 错误 commitSha、错误 eventType、缺 decision 和非对象 data 均不能推进，异常消息在死信中可查。
6. 服务重启后已持久化任务继续执行；AIGC 重启后继续等待。
7. 超期结果不推进；审核页能打开有权限访问的 HTTPS 报告。

本地模拟器在 `tools/audit-simulator/`，仅作开发测试，不能当作真实审计。生产拓扑创建、API 配置与恢复步骤见同包 `MQ-DEPLOYMENT.md`。凭据通过受保护渠道交付，不粘贴到本文或业务消息。
