# 配置热更新与设备回执部署

本功能需要配套发布 AIGC API、Portal 和新版 DSH。旧客户端继续使用原功能，但不会产生更新回执，管理页显示“未上报”。本次源码包含实现及本地验证，不代表线上已部署。

## 管理入口和回执含义

“客户端运维 → 配置更新状态”，权限复用 `model.manage`。列表按用户及设备展示目标版本、已应用版本、最后应答、成功时间、客户端版本和安全错误码；搜索姓名/工号并按状态过滤，每 10 秒刷新。

- 客户端已应用：DSH Host 成功校验快照、刷新模型目录并提交了匹配的快照回执。不是“MQ 已发送”，也不承诺所有窗口均已绘制完成。
- 待更新：设备在线，但已应用版本低于当前目标版本。
- 更新失败：设备反馈快照读取或应用失败，保留原成功版本，后台继续重试。
- 离线：90 秒未收到设备心跳；版本列仍可判断其上次是否更新。
- 未上报：无设备回执，可能未登录、未启动或客户端版本不支持。不能仅凭这个状态断言用户使用旧版。

## 持久化与协议

新增 `ConfigSyncRevisions`、`ConfigSyncEvents`、`ConfigSyncDevices`，由 API 启动增量建表，不重建现有表。配置写入、版本推进、Outbox 在同一数据库事务提交；PostgreSQL advisory transaction lock 保证并发更新的提交顺序。模型配置、模型授权、角色/部门/人员归属、虚拟 Key 配置、配方、配方分配和增量包均触发全局配置版本；登录时间、设备心跳、结算记录不会生成配置事件。

MQ 按域发送失效提示，第一版使用全局版本，所有在线 Host 拉取自己的授权快照，兼顾撤权前后成员。快照中不含模型 Key，MQ 事件不含配置正文。客户端在快照前后核对版本和用户身份，校验成功才应用；服务端对成功回执校验用户、设备、已下发版本与 offerId，不接受未获取过的快照或未来版本。设备版本只向前推进，失败回执不能降级已成功版本。

SSE：`GET /v1/config/events`；版本：`GET /v1/config/versions`；快照：`GET /v1/config/snapshot?deviceId=<UUID>`；应答：`POST /v1/config/applied`。均使用现有 DSH bearer 会话，token 不放进 URL。Host 每 30–35 秒进行版本补偿及心跳；事件连接每 15 秒检查数据库版本，MQ 暂停时仍可收敛。MQ 恢复后唤醒所有本机连接。账号切换及插件卸载取消旧连接和请求。

倍率使用现有计费预占记录的倍率快照；本次不重算历史账单、不清除待结算记录、不主动打断已有流。外部请求直连 LiteLLM 的既有路径仍要求 LiteLLM 执行自身授权和密钥失效。

## 现有 MQ 上的增量拓扑

复用 nj304 的 `aigc-mq:5672`、vhost `/aigc`。保留现有三账号及用户同步队列；另设 `aigc.config.events` topic exchange 和无管理标签的 `aigc_config_runtime`。

每个 API 实例创建独立 `aigc.config.api.<32位十六进制实例ID>` classic/exclusive/auto-delete 队列，绑定 `config.#`。运行账号只允许配置该前缀队列，读写配置 Exchange 与该前缀队列，不接触用户同步 Exchange/队列。

在部署目录运行，密码由运维输入，不写进命令历史：

```bash
umask 077
read -r -s -p 'Config MQ runtime password: ' MQ_CONFIG_PASSWORD; echo
export MQ_CONFIG_PASSWORD
python3 prepare-config-sync.py
```

产物是 `generated/config-sync-definitions.json`，仅包含带盐密码哈希及增量拓扑。用既有管理权限将其复制至 MQ Pod，执行 `rabbitmqctl import_definitions <容器内文件路径>`。该导入不会删除未列出的既有账号和拓扑；不要替换原 definitions 启动文件以免遗漏原三账号。需要同时把新用户/Exchange 纳入最终启动 definitions 或运维备份，保证空数据卷重建时可恢复。

把以下配置 merge patch 到既有 `aigc-secrets`，不要替换整个 Secret；密码使用刚才输入的同一值，沿用 `DEPLOYMENT-RUNBOOK.md` 的受保护临时 patch 文件方式：

```text
ConfigSync__Enabled=true
ConfigSync__HostName=aigc-mq
ConfigSync__Port=5672
ConfigSync__VirtualHost=/aigc
ConfigSync__Exchange=aigc.config.events
ConfigSync__QueuePrefix=aigc.config.api.
ConfigSync__UserName=aigc_config_runtime
ConfigSync__Password=<从受保护环境变量或文件读取>
ConfigSync__UseTls=false
```

如果实际集群使用 TLS，按现有证书设置 `UseTls=true` 和 `TlsServerName`。运行时不使用管理账号。生产地址从部署配置读取；没有硬编码 localhost。API 需重启一次加载新增运行配置。

未启用 MQ 时功能仍通过版本核对工作，管理页明确显示 MQ 未启用；启用后检查 `ConfigSync.MqConnected`，失败只记录安全错误码。消息发布使用 confirms 和 mandatory，指数退避重试，待发/失败事件数量可在管理页查看。该数量不是未更新客户端数量。

## 反向代理和验收

SSE 响应需禁止缓存/缓冲，允许流式 flush 和超过心跳间隔的读超时。API 设置 `Content-Type: text/event-stream`、`Cache-Control: no-store`、`X-Accel-Buffering: no`，反代仍须允许长连接。DSH 每个 Host 只建立一条配置事件连接，窗口通过已有 Host Remote 事件刷新。

验收顺序：发布 API/Portal → 配置增量 MQ 拓扑和 Secret → 发布新版 DSH → 登录两台设备 → 修改倍率/配方 → 观察目标版本增加及设备回执更新 → 断开一台设备后再修改 → 重连后确认补齐。再测试 MQ 断开时版本补偿、多 API 实例、撤权、并发修改和失败恢复。上线前备份数据库与 MQ definitions；回退可停止新客户端同步并关闭 `ConfigSync__Enabled`，保留新增表及已有数据。
