# AIGC 与代码审查服务 RabbitMQ 连接及队列信息

文档日期：2026-11-13。供代码审查服务开发、部署人员使用。

根据平台运维执行反馈，业务拓扑创建脚本已执行成功；真实审查服务联调待双方完成。

## 1. 连接参数

| 参数 | 值 |
| --- | --- |
| 协议 | AMQP 0-9-1 |
| 主机 | `172.28.2.33` |
| 端口 | `30672` |
| Virtual Host | `/aigc` |
| 用户名 | `aigc_code_audit` |
| 密码 | PASSword00@aigchub22 |
| TLS | 当前未启用，使用受控内网连接 |

若客户端使用连接 URI，vhost `/aigc` 应编码为 `%2Faigc`，密码中的特殊字符也需 URL 编码。优先使用客户端独立的 host、port、virtual_host、username、password 参数。

同 Kubernetes 集群中的服务也可使用 `aigc-mq.bosch-aigc-dsh.svc.cluster.local:5672`；集群外使用上面的节点地址和 NodePort。

## 2. 消费审查请求（AIGC → 审查服务）

| 参数 | 值 |
| --- | --- |
| 消费队列 | `aigc.workflow.code-audit.requests` |
| 请求交换机 | `aigc.workflow.commands` |
| 交换机类型 | `direct` |
| Routing key | `code-audit.submit.v1` |
| 正文 `event_type` / AMQP `type` | `review.requested` |
| 编码 | UTF-8 JSON |

审查服务直接消费上述队列。**Routing key 与事件类型不同**：`code-audit.submit.v1` 用于消息路由，`review.requested` 用于标识请求事件。

## 3. 发布审查结果（审查服务 → AIGC）

| 参数 | 值 |
| --- | --- |
| 发布目标交换机 | `aigc.workflow.code-audit.results` |
| 交换机类型 | `direct` |
| 已登记任务的终态 Routing key | `review.finished` |
| 登记任务前拒绝的 Routing key | `review.rejected` |
| AIGC 消费的结果队列 | `aigc.workflow.code-audit.results` |

请向结果交换机发布，不通过默认交换机直接发送至队列。

| 结果场景 | 正文 `status` | 正文 `verdict` | Routing key / 正文 `event_type` |
| --- | --- | --- | --- |
| 审查通过 | `Completed` | `Passed` | `review.finished` |
| 审查不通过 | `Completed` | `Failed` | `review.finished` |
| 警告 / 需人工复核 | `Completed` | `Warning` / `Needs Review` | `review.finished` |
| 执行失败 | `Failed` | 按双方接口契约填写 | `review.finished` |
| 已登记任务取消 | `Cancelled` | 按双方接口契约填写 | `review.finished` |
| 登记任务前拒绝 | `Rejected` | 按双方接口契约填写 | `review.rejected` |

`review.rejected` 表示请求未被登记，不能用于表示“审查完成但审核不通过”。

## 4. AMQP 消息属性

| 属性 | 请求 | 结果 |
| --- | --- | --- |
| `content_type` | `application/json` | `application/json` |
| `content_encoding` | `utf-8` | `utf-8` |
| `delivery_mode` | `2`（持久消息） | `2`（持久消息） |
| `message_id` | 正文 `message_id` | 正文 `event_id` |
| `correlation_id` | 正文 `request_id` | 原请求 `request_id` |
| `type` | `review.requested` | 正文 `event_type` |
| `timestamp` | 正文 `produced_at` 对应的 Unix 秒 | 正文 `finished_at` 对应的 Unix 秒 |

采用双方约定的 snake_case JSON。结果正文最大 **64 KiB**，字段与 AMQP 属性必须一致，不增加未约定字段。结果必须回传原请求关联信息，包括 `request_id`、`request_message_id` 及契约要求的流程、申请人工号、仓库和冻结提交信息。

## 5. 消费、重试与权限

- 交换机、队列和绑定已由平台预置。业务账号没有 configure 权限，客户端应关闭自动创建/声明拓扑；不要执行 QueueDeclare、ExchangeDeclare 或 QueueBind，包括被框架隐式调用的声明。
- 账号仅允许读取审查请求队列、写入审查结果交换机；无管理权限、无部署业务权限。结果队列由 AIGC 消费，审查服务不消费。
- 使用手动 ACK。请求应在可靠登记/持久化后确认，或在可靠完成处理后确认，避免收到即 ACK 后任务丢失。
- AIGC 请求可能重复投递，审查服务需要按 `request_id` 幂等登记，同一调用不应重复创建审查任务。
- 结果发布使用 Publisher Confirms 和 `mandatory=true`，处理未路由返回、连接中断与确认超时。重发同一结果应复用原 `event_id` 和正文，AIGC 按事件去重。
- 生产请求/结果队列为 durable quorum；配置7天TTL、每队列10,000条/256MiB、reject-publish、delivery-limit=20及死信策略。TTL不等于业务截止时间，业务截止以请求 `deadline_at` 为准。
- 死信由平台运维处理，不由审查服务自动回灌。审查账号不具备死信队列权限。

## 6. 业务数据约定及联调

- `reviewer_subject` 表示申请人工号，不是当前流程审批人工号。
- 仓库为 Gitea `repository.full_name`，代码版本为冻结的完整 `commit_sha`。
- 双方应确认审查系统连接的 Gitea 实例为 `https://git.boschhuayu-steering.com`。
- 审查系统使用自己的只读服务凭据访问 Gitea，AIGC 不通过 MQ 发送用户 Token。
- `review_url` 为 HTTPS 报告地址；流程审批人可能不同于申请人，需要审查系统授予审批人相应报告访问权限。

请联调：通过、不通过、警告/人工复核、执行失败、取消、登记拒绝、重复请求及重复结果。确认完整请求关联、任务幂等、结果可路由和报告可访问。

本文件用于连接与队列交付；完整JSON字段及状态组合以双方已确认的《AIGC与代码审查系统RabbitMQ接口文档（2026-11-12简化版）》为准。平台适配说明另见 `AIGC-CODE-REVIEW-CONTRACT-20261112.md`，可随本文一并提供。
