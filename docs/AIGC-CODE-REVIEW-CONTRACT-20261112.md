# 代码审查协议接入与切换（2026-11-12）

本次按审计方提供的《AIGC 与代码审查系统 RabbitMQ 接口文档（简化版）》实施。仅适配代码审查，部署服务保持 generic-v1。审批顺序完全由流程设计配置，不新增或强制前置审批。

## 协议登记

在“第三方服务”编辑 `code-audit`，保留旧操作以兼容旧调用，追加：

```json
[
  {"code":"audit.submit.v1","resultEvent":"audit.completed.v1","protocol":"generic-v1"},
  {"code":"review.requested","resultEvent":"review.finished","protocol":"code-review-20261112"}
]
```

新流程的审查节点选择 `review.requested`；同一操作接受 `review.finished` 和 `review.rejected` 两种外部事件。不要分别创建两个调用或把后者当成正常审核未通过。协议名是 AIGC 内部适配器标识，不会写到 MQ 正文。

旧的已发布定义及已持久化 Outbox 不会被自动改写。复制流程生成新版本后选择新操作再发布，新实例使用新版本；旧实例继续按原协议运行。不要在结果队列仍有旧消息时切断旧消费者能力。原审计方若不支持旧格式，须先清点旧调用并由业务方决定结束或重新申请，不能静默转换已发送请求。

## 请求数据

AIGC 后端从 Gitea API 保存 repository.full_name 与完整 commit_sha；从申请人用户记录读取 reviewer_subject。此字段虽名为 reviewer，但按对方契约代表**申请人工号**，不是当前审批人。绝不使用表单自报的工号或从 URL 截取仓库名称。

消息体仅含以下字段：message_id、event_type、request_id、workflow_id、produced_at、deadline_at、trace_id、reviewer_subject、repository、review；没有 schema_version、serviceCode、operationCode、data 或用户凭据。

本实现 message_id 与 request_id 均采用本次调用 UUID，workflow_id 为流程实例 UUID。同一调用投递重试复用完整原始正文、时间及 ID；业务重新提交创建新调用 ID，同一流程 workflow_id 保持不变。默认截止时间 24 小时，由节点超时配置决定。

AMQP content_type=application/json、content_encoding=utf-8、delivery_mode=2、message_id 等于正文 message_id、correlation_id 等于 request_id、type=review.requested、timestamp 对应 produced_at。

现存申请缺少 full_name 时，不从 URL 猜测：需通过 Gitea 重新验证固定 Commit 后再发起。AIGC 所选 Gitea 实例必须与审查系统的 GITEA_BASE_URL 为同一实例，由部署双方确认。审查系统使用自己的只读服务 Token 拉取代码，AIGC 不通过 MQ 提供 Token。

## 状态与流转

| 外部 status / verdict | 节点结果出口 | 含义 |
| --- | --- | --- |
| Completed / Passed | passed | 审核通过 |
| Completed / Failed | rejected | 审核不通过 |
| Completed / Warning 或 Needs Review | needs-review | 人工复核 |
| Failed | failed | 执行失败 |
| Cancelled | cancelled | 取消 |
| Rejected | request-rejected | 登记任务前拒绝 |

result 保存为风险等级，不能把 `result=High` 当执行失败；Completed 表示审查执行完成。Cancelled 不要求 error，Failed/Rejected 必须提供结构化 error。review_url 为已登记任务的 HTTPS 链接，Rejected 的 task_id/review_url 必须为 null。

needs-review 必须经连线到人工任务（允许经过结果网关），不能直接部署或通过结束。新建模板为 Warning/Needs Review 提供独立人工复核分支，不改变原先的正常审计与部署审批顺序。cancelled、request-rejected 可配置专用出口，也可走默认异常出口。

REQUEST_CONFLICT 为特殊非消耗事件：记录 Inbox、历史和通知，保留原调用等待状态；原任务的正常结果仍可推进。error.retryable 只展示“恢复后可重新发起”，不自动重用原 request_id 重做审查。

## 结果校验与幂等

结果 DTO 使用严格 snake_case，拒绝未知字段、重复字段、缺必填字段、错误类型、非法 null、首尾空白/控制字符、无时区时间和超出枚举的值。结果正文最大 64 KiB。

event_id/request_message_id/task_id 为 UUID，request_id 满足双方 ASCII 格式。AIGC 发出的 request_id 是 UUID，因此结果必须回传同一 UUID。按状态检查 task_id/review_url/verdict/result/error 的组合；结果 AMQP 的 message_id、correlation_id、type、timestamp 与正文逐一核对。

以 `(内部服务标识, 规范化event_id)` 去重，用 request_id 定位调用，匹配 request_message_id、非空 workflow_id、reviewer_subject、仓库全名及冻结 SHA。Rejected 尚未绑定的字段允许为 null。过期或旧调用结果只保存收据，不推进。

事务保存收据、节点输出、原始结果和后续任务后再 ACK。无法通过契约或关联校验的消息 reject(requeue=false) 到死信；数据库/连接临时异常不 ACK，由 Broker 重投。协议类型随调用持久化，通用格式不能绕过审查协议校验。

## MQ 通道（沿用现场 Service）

用户现场确认：nj304 `172.28.2.33`，现有 `aigc-mq` 为 NodePort，AMQP 30672、管理端口 30242、externalTrafficPolicy=Cluster。集群内 API 使用 aigc-mq:5672，vhost=/aigc。本次不修改 Service。

| 方向 | Exchange | Routing key | Queue |
| --- | --- | --- | --- |
| 请求 | aigc.workflow.commands | code-audit.submit.v1 | aigc.workflow.code-audit.requests |
| 正常终态 | aigc.workflow.code-audit.results | review.finished | aigc.workflow.code-audit.results |
| 登记拒绝 | aigc.workflow.code-audit.results | review.rejected | aigc.workflow.code-audit.results |

Routing key 与 AMQP type 是不同概念。AIGC 配置 `IntegrationConnections__CodeAudit__RoutingKeys__review.requested=code-audit.submit.v1`；保留旧 audit.submit.v1 映射。新增两条结果绑定，保留 audit.completed.v1 绑定供旧协议使用。已更新 `deploy/nj304-rabbitmq/workflow_topology.py` 和增量创建工具；只有现场执行工具后新增绑定才生效，本轮不连接或修改生产。

审计方账号 aigc_code_audit 只读请求队列，只写自身结果交换机，不能使用默认交换机、创建拓扑或发布部署结果。既有容量、TTL、quorum、死信策略继续有效，详见生产 MQ 文档的资源部分；原生产文档的旧审计 JSON 示例由本文及审计方简化协议替代。

## 页面与联调

审核详情展示执行状态、原始 verdict、风险等级、审查任务、时间、仓库、Commit、工号、结构化错误与是否适合重发。完整报告通过 review_url 打开。审查方目前规定普通用户仅看本人任务：若流程审核人不是申请人，需审查方授予审核角色/管理员权限，否则“有链接”不代表“审核人有权查看”。

`tools/audit-simulator` 已识别新旧请求格式，新增 warning、needs-review、cancel、request-rejected 模拟终态。模拟器仅用于隔离开发环境，无生产审计能力或持久化幂等保证。新协议测试时指定结果交换机 aigc.workflow.code-audit.results；模拟器按结果 event_type 使用对应 routing key，开启 confirms/mandatory 并设置完整 AMQP 属性。

本轮不构建镜像或离线包。源码、自动测试、模拟协议验证和真实审计服务联调应分别记录；审计方 MQ 组件仍需按其交付安排接入后，双方完成真实仓库、CAS 详情权限、取消及拒绝场景联调。
