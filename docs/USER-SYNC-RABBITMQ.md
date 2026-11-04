# AIGC 用户同步与 RabbitMQ

AIGC 是用户资料唯一来源，只生产消息，不管理接收服务的消费进度。管理入口为「用户管理 → 用户同步」。接收方不得把同步字段反向写回 AIGC。

## 行为与状态

- 后台、CAS 首次登录、聊天工具等通过 EF 保存用户时，新增、姓名/工号/邮箱/部门/启停变化自动生成 Outbox。部门编码、名称或启停改变时，其成员也生成新版用户消息。密码、哈希、Token、模型凭据、登录时间不进入消息。角色和资源授权不在此协议同步范围。
- 用户修改、数据版本递增和 Outbox 插入由同一次数据库保存提交。用户版本有并发检查；过期编辑返回冲突，调用方应刷新后重试。不要使用 `ExecuteUpdate` 或直写 SQL 修改同步字段，这些操作绕过 EF 捕获。
- 首次接入或新增接收方，先配置持久化队列与绑定，再执行全量同步。包含停用用户；每位用户生成 `user.snapshot`。快照广播到所有已绑定队列，已有服务也可能再次收到。
- `Pending`＝待发送；`Sent`＝RabbitMQ 已确认接收；`Failed`＝本次发送失败。AIGC 不消费业务回执，因此不显示“接收方同步成功”。
- 发送使用持久化消息、publisher confirms 和 mandatory 路由检查。没有匹配队列、broker nack、连接失败或超时都不会标记已发送。
- 发送失败指数退避，默认每个重试周期最多尝试 10 次，到上限后保留记录，管理员可手动重试。尝试次数累计，手动重试保留原 eventId、原始内容和用户版本。进程停止或确认后数据库提交失败可能重复发送，接收方必须幂等。
- 默认只采集，`UserSync:Enabled=false` 时不会连接 MQ，消息继续留在数据库。启用后发送历史积压。当前不自动清理发送记录；容量较大时按组织保留策略归档已发送记录，不能删除待发送或失败记录。
- 全量请求通过客户端生成的 `requestId` 幂等；网络中断后用原编号再次提交不会重复创建批次。每次全量以一次数据库查询读取用户、版本和部门快照，再持久化该批次所有消息；应避免在超大用户库高峰时重复发起。

## 拓扑与接收方

| 项目 | 默认值 |
| --- | --- |
| 主机 | nj304，部署时替换为可解析的内网域名/IP |
| AMQP 端口 | 5672；开启 TLS 时按实际监听端口配置 |
| Virtual host | `/aigc` |
| Exchange | `aigc.identity.users`，durable topic |
| 绑定键 | `aigc.user.*.v1` |
| 首个队列 | `aigc.users.service-1`，durable quorum |
| 生产账号 | `aigc_user_producer`，仅允许写入 Exchange |
| 首个消费账号 | `aigc_user_service_1`，仅允许读取自己的队列 |

AIGC 不创建或删除队列、不拉取消息。队列、绑定及账号由 MQ 部署材料预置。接入信息可以在页面复制，包含接收服务的消费账号名称，不包含其密码，更不包含生产账号或生产密码。队列已存在但没有在线消费者时，消息仍可标记为“已发送至 MQ”，等待接收方上线；这不表示已经消费。

多个服务必须使用不同的队列和账号，同一服务的多个实例才共享一个队列。新增服务时由运维新增 durable 队列、绑定和消费权限，并在 AIGC 的 `UserSync:Consumers` 中增加展示信息；不需要改 AIGC 生产逻辑。接收队列应避免 TTL、溢出丢弃等主动丢消息策略。持久化和单节点 quorum 不能替代节点备份或多节点高可用。

## 消息格式 v1

AMQP `message_id` 等于 JSON `eventId`，`content_type=application/json`，UTF-8，`app_id=aigc`。路由键分别是 `aigc.user.upsert.v1`、`aigc.user.snapshot.v1`、`aigc.user.deleted.v1`。

```json
{
  "schemaVersion": 1,
  "eventId": "2ad26389-11db-4c00-85ce-bd01ce417ced",
  "eventType": "user.upsert",
  "source": "aigc",
  "occurredAt": "2026-11-02T02:00:00+00:00",
  "batchId": null,
  "userVersion": 3,
  "user": {
    "id": "69e63b19-121c-4539-9d98-7857a237061e",
    "employeeNo": "sample001",
    "name": "示例用户",
    "email": "sample@example.test",
    "departmentId": "782b0714-38a5-4a98-8ac1-f8384b541c22",
    "department": {
      "id": "782b0714-38a5-4a98-8ac1-f8384b541c22",
      "code": "sample",
      "name": "示例部门",
      "isEnabled": true
    },
    "isEnabled": true,
    "isDeleted": false
  }
}
```

`user.id` 是稳定主键，工号可变。未分配部门时 `departmentId` 和 `department` 都为 null。历史用户在首次升级后版本可为 0；首次资料变化后开始递增。`batchId` 仅全量快照有值。`occurredAt` 是事件生成时间，不是消费时间，不应用它代替数据版本排序。

接收方在本地同一事务中：检查 eventId 是否已处理；按 user.id 比较 userVersion；只应用高于本地版本的数据（首次接收须允许版本 0）；相同或旧版本跳过；保存 eventId 和最高版本；事务提交后再手动 ack。较新的 `user.deleted` 是 tombstone，应停用或删除关联资料，并保留最高版本，防止旧事件把用户恢复。重复 eventId 应直接 ack。处理失败不能 ack，接收方负责重试和死信处理。

全量快照与增量可能交错，也可能重复或跨 API 副本乱序。userVersion 的条件更新必须在接收方数据库中原子执行，不能先读版本再无条件覆盖。完整消息是用户在该版本的状态，不是字段补丁。快照不是“删除接收方未出现用户”的指令，不能仅凭某个分页或批次缺少用户就清理本地数据。

## API 配置

通过环境变量或现有部署 Secret 配置，不将生产密码提交仓库：

```text
UserSync__Enabled=true
UserSync__HostName=nj304.internal.example
UserSync__Port=5672
UserSync__VirtualHost=/aigc
UserSync__Exchange=aigc.identity.users
UserSync__UserName=aigc_user_producer
UserSync__Password=<从部署 Secret 注入>
UserSync__UseTls=false
UserSync__PollSeconds=5
UserSync__MaximumAttempts=10
UserSync__Consumers__0__ServiceName=接收服务一
UserSync__Consumers__0__Queue=aigc.users.service-1
UserSync__Consumers__0__UserName=aigc_user_service_1
```

TLS 可设置 `UserSync__UseTls=true`、匹配端口及证书域名 `UserSync__TlsServerName`，使用系统信任链，不跳过证书校验。附带 Compose 是内网 AMQP 基础模板；如需跨不可信网络，先在 broker 配置证书和 TLS listener，再启用 TLS 连接。配置修改需要重启 API；数据库新表、索引和用户版本列由启动时幂等增量初始化创建。部署前正常备份数据库。

## 管理 API

所有 `/api/users/sync/*` 接口要求 `user.manage`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/users/sync/connection` | 无密码的接收方接入信息 |
| GET | `/api/users/sync/summary` | 全局待发送、已发送、失败及最近发送时间 |
| GET | `/api/users/sync/messages` | 支持 page/pageSize/keyword/status/userId/batchId 的记录查询 |
| GET | `/api/users/sync/batches` | 最近十次全量任务及进度 |
| POST | `/api/users/sync/snapshot` | JSON `{ "requestId": "UUID" }`，幂等生成批次，202 返回 id 和 total |
| POST | `/api/users/sync/messages/{id}/retry` | 失败消息重新排队，保留 eventId 与累计次数 |

用户管理列表的 `sync` 是该用户最新数据版本、最近生成消息的发送情况。较早消息发送成功不代表最新版本已发送；查询详情应以用户同步页面为准。

## API 容器运维日志

MQ 日志复用 AIGC 的 JSON 标准输出和已有滚动文件归档，统一包含 `MQ.UserSync.` 前缀。更新 API 镜像并重启容器后生效，无需新增日志服务。空闲轮询不输出日志，发送成功为 Information，发送失败和连接失败为 Warning，后台分发周期异常为 Error。

```bash
# 将 aigc-api 替换为实际 API 容器名；以下命令只查看日志。
docker logs --since 30m -f aigc-api 2>&1 | grep 'MQ.UserSync.'

# 按某次全量批次 UUID 或消息事件 UUID 筛选
docker logs --since 24h aigc-api 2>&1 | grep '要查询的 UUID'
```

| JSON EventId | 日志标记 | 运维含义 |
| --- | --- | --- |
| 6200 | `MQ.UserSync.WorkerStarted` | 是否启用、主机、端口、vhost、Exchange、TLS、轮询间隔和重试上限 |
| 6201 | `MQ.UserSync.Disabled` | 当前仅采集，不连接 MQ；待发送记录继续保留 |
| 6202 / 6213 | `WorkerStopped` / `ProducerStopped` | 工作线程停止 / AMQP 连接释放 |
| 6210 / 6211 | `Connecting` / `Connected` | 开始连接 / 连接和确认通道就绪，重连也会记录 |
| 6212 | `ConnectionFailed` | 连接失败，包含安全原因代码及异常类型 |
| 6220 | `MQ.UserSync.Sent` | broker 确认且 Outbox 状态已提交；包含消息 EventId、BatchId、UserId、UserVersion、事件类型、累计尝试次数及发送时间 |
| 6221 | `MQ.UserSync.SendFailed` | 自动重试已安排；`AutoRetry=true`，包含 `NextAttemptAt` |
| 6222 | `MQ.UserSync.SendFailed` | 本轮重试达到上限；`AutoRetry=false`，需排查后从页面手动重试 |
| 6223 | `MQ.UserSync.CycleFailed` | 分发周期异常，持久化 Outbox 留待后续处理 |
| 6230 | `MQ.UserSync.SnapshotQueued` | 全量快照成功入库，记录 BatchId、用户条数和操作人 ID；相同 requestId 不重复记录入队 |
| 6231 | `MQ.UserSync.ManualRetry` | 管理员将失败消息重新入队，记录原消息 EventId 和操作人 ID |

JSON 顶层 `EventId` 是上表的日志事件编号；`State.EventId` 是 MQ 消息 UUID，两者含义不同。所有时间字段保留时区。`FailureCode` 可为 `unroutable`（无匹配队列）、`broker-nack`、`broker-unreachable`、`authentication-failed`、`tls-failed`、`timeout`、`transport-failed` 或 `operation-failed`，并提供 `ErrorType` 辅助排查。外层 broker 连接异常可能包装认证/TLS 错误，此时显示 `broker-unreachable`，应结合 RabbitMQ 侧日志确认根因。

新增 MQ 日志字段不记录账号密码、Token、消息正文、姓名或邮箱，也不直接输出可能含凭据的 AMQP 异常文本；管理员发起全量或重试时，仍附带平台原有的 HTTP 请求追踪与操作人上下文。MQ 发送成功只代表 RabbitMQ 接收并且本地状态保存，不表示接收服务已落库。若 broker 已确认但 Outbox 提交失败，会记录周期异常而不会误报 `Sent`；后续可能重发，仍需接收方幂等。

## nj304 部署

使用 [部署材料](../deploy/nj304-rabbitmq/README.md)。本次只在本机隔离容器验证，未连接或部署 nj304。

## 验证

后端普通测试覆盖自动捕获、部门联动、敏感字段排除、幂等快照、权限、重试及发送状态。`UserSyncIntegrationTests` 使用隔离 PostgreSQL/RabbitMQ，验证数据库回滚、乐观并发、真实确认、mandatory 无路由返回以及同 eventId 重试。

集成测试要求 `AIGC_TEST_POSTGRES` 指向本机专用数据库 `aigc_usersync_test`，该库会被测试删除；不能指向开发或生产库。同时设置 `AIGC_TEST_RABBITMQ_PORT` 和 `AIGC_TEST_RABBITMQ_MANAGEMENT_PORT`，使用部署生成器的测试账号拓扑。测试文件列出的 `test-*-only-20261102` 均为隔离测试凭据，不可用于生产。

协议使用 RabbitMQ 官方的 [publisher confirms 与消费确认分离语义](https://www.rabbitmq.com/docs/confirms)，生产实现使用官方 [RabbitMQ .NET 客户端](https://www.rabbitmq.com/client-libraries/dotnet-api-guide)。
