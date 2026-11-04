# nj304 RabbitMQ 用户同步部署材料

本目录为待部署材料；不会自动连接 nj304。业务协议和 API 配置见 [用户同步文档](../../docs/USER-SYNC-RABBITMQ.md)。默认拓扑含一个生产账号、一个消费账号、一个管理账号，生产端只有 Exchange 写权限，消费端只有独立队列读权限。

1. 将本目录复制到 nj304 固定部署目录。准备 Docker Compose、Python 3，确保数据目录有持久化备份；镜像 `rabbitmq:4.2-management` 在本机验证通过，生产可将 `RABBITMQ_IMAGE` 固定到组织批准的版本和 digest。本次验证拉取的 digest 为 `sha256:d1fb8b38bd0805935907a22b2b7483fba38c9a8dd7e8a74bfba4a6e7a9e91707`。
2. 复制 `.env.example` 为 `.env`，将 `MQ_BIND_ADDRESS` 改为 nj304 可被 AIGC API 和接收服务访问的内网地址；防火墙按实际来源放行 AMQP 端口。管理端口默认只监听回环地址，通过本机或 SSH 隧道维护。示例保持回环绑定，避免未经配置就暴露服务。
3. 从组织的凭据管理系统读取三个不同的强密码到当前进程环境：`MQ_ADMIN_PASSWORD`、`MQ_PRODUCER_PASSWORD`、`MQ_CONSUMER_PASSWORD`，每个至少16位。在当前目录运行 `python3 prepare.py`。生成文件只保存带随机盐的密码哈希和队列拓扑，不打印明文密码。妥善限制 `generated/definitions.json` 所在目录的访问权限；它已被 Git 忽略。
4. 运行 `docker compose -p aigc-user-sync up -d`，通过 `docker compose -p aigc-user-sync exec rabbitmq rabbitmq-diagnostics -q ping` 检查节点，通过管理界面确认 `/aigc`、Exchange、quorum 队列及绑定均存在。不要使用 `down -v` 删除生产数据卷。
5. 使用 Secret 为 AIGC API 注入 `aigc_user_producer` 账号的用户名、密码和 nj304 连接地址，启用 `UserSync__Enabled=true` 并重启 API。接收方仅获得 `aigc_user_service_1` 账号的密码，通过另行安全渠道交付。复制信息功能不会泄露生产密码，也不保存消费密码。
6. 接收服务先开始消费，再在「用户管理 → 用户同步」执行一次全量同步，观察批次进度和失败详情。新增用户或修改资料后应看到增量消息及“已发送至 MQ”。接收服务独立验证落库结果。

生成器重跑将重新生成密码哈希；应用 definitions 会更新同名用户密码。生产首次部署完成后，账号轮换和拓扑变更应按运维流程执行，不要把测试 definitions 覆盖到生产。新增服务时创建独立持久化队列、绑定键 `aigc.user.*.v1` 与只读消费账号，然后更新 AIGC 的 `UserSync:Consumers` 展示配置并再次发送全量快照。

单节点 quorum 的持久化不等于多节点高可用。该模板使用一个节点，节点或磁盘故障仍需从备份恢复；重要生产环境可按运维标准部署多节点 RabbitMQ 集群。AIGC 的数据库 Outbox 保留未发送和失败记录，不能依赖它重建已被管理端删除的 RabbitMQ 消息；可用全量快照恢复当前用户资料。

API 容器的 MQ 日志均带 `MQ.UserSync.` 前缀，覆盖启动、连接、发送、重试上限和手动全量操作；可用 `docker logs --since 30m -f <API容器名> 2>&1 | grep "MQ.UserSync."` 查看，字段和事件编号见[运维日志说明](../../docs/USER-SYNC-RABBITMQ.md#api-容器运维日志)。更新 API 容器后才会出现本次新增的日志。
