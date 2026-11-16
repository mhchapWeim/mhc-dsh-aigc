# nj304 现有 RabbitMQ：代码审查业务增量命令

**包含 MQ 创建、Secret 与 ConfigMap 修改的联合步骤见 [ALL-DEPLOYMENT-COMMANDS.md](ALL-DEPLOYMENT-COMMANDS.md)。** 需要分开存储时使用 `--apply --patch-api --patch-configmap`；下文 `--patch-api` 默认将全部 MQ 配置放在 Secret，二者择一。

本次复用现有 RabbitMQ，不安装新 broker，不修改 Deployment/Service/NodePort/PV/PVC，不覆盖用户同步或配置热更新资源。

现场基线由用户 2026-11-12 查询确认：namespace `bosch-aigc-dsh`，Service `aigc-mq` 为 NodePort；AMQP `5672→30672`，管理 `15672→30242`，externalTrafficPolicy=Cluster；Pod 在 `bosch-k8s-node-nj304`，节点 IP `172.28.2.33`，vhost `/aigc`。

## 1. 运行位置和只读预检

以下在 **Kubernetes 控制节点 Bash**、解压后的本次交付目录执行，需要 kubectl、Python 3.9+。不在 Windows PowerShell 执行。

```bash
set -euo pipefail
umask 077
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get svc aigc-mq -o wide
kubectl -n bosch-aigc-dsh get pods -l app=aigc-mq -o wide
kubectl get node bosch-k8s-node-nj304 -o wide
kubectl -n bosch-aigc-dsh describe secret aigc-mq-definitions
kubectl -n bosch-aigc-dsh describe secret aigc-secrets
python3 mq/configure-workflow.py > workflow-plan.json
python3 -m json.tool workflow-plan.json >/dev/null
```

不带 `--apply` 仅输出无密码的离线拓扑计划，不读取或修改集群。`describe secret` 只显示键与长度，勿改为输出 Secret 正文。不要 apply 仓库旧 rabbitmq-k8s.yaml：其中 ClusterIP 基线已落后于现场。

## 2. 创建业务拓扑并合并 API 配置

```bash
python3 mq/configure-workflow.py --apply --patch-api
```

脚本交互读取现有管理员（默认 `aigc_mq_admin`）及密码，再为三个新业务账号分别输入并确认至少 20 位密码。输入不回显，不放在命令参数或 shell 历史。账号和密码由运维安全保管，第三方只拿自己的账号。

它先校验现有 Service 仍是 NodePort/30672，再通过临时 localhost:18672 port-forward 接入现有管理端口 15672；检查 `/aigc` 已存在。只增量创建本业务交换机、quorum 队列、绑定、策略和账号。不会重启 RabbitMQ、API 或 Portal。

若 18672 已占用，使用 `--local-port 18673`。连接失败不会将管理接口切换到公网。已有同名账号密码不符、账号带管理标签或队列/交换机不可变参数不同会停止；不删队列、不重置其他账号，不为绕过校验重建资源。

### 拓扑

| 用途 | Exchange | Routing key | Queue |
| --- | --- | --- | --- |
| 审查请求 | aigc.workflow.commands（direct） | code-audit.submit.v1 | aigc.workflow.code-audit.requests |
| 审查终态 | aigc.workflow.code-audit.results（direct） | review.finished | aigc.workflow.code-audit.results |
| 登记拒绝 | 同上 | review.rejected | 同上 |
| 旧审计结果兼容 | 同上 | audit.completed.v1 | 同上 |
| 部署请求 | aigc.workflow.commands | deployment.submit.v1 | aigc.workflow.deployment.requests |
| 部署结果 | aigc.workflow.deployment.results（direct） | deploy.completed.v1 | aigc.workflow.deployment.results |
| 死信 | aigc.workflow.dead-letter（fanout） | 任意 | aigc.workflow.dead-letters |

请求/结果队列 TTL 7 天、每队列 10,000 条/256 MiB，reject-publish，delivery-limit=20，at-least-once 死信。死信 TTL 14 天、10,000 条/256 MiB，无自动回环。单节点 quorum 不等于多节点高可用；需要监控积压与死信容量。

| 账号 | 写权限 | 读权限 |
| --- | --- | --- |
| aigc_workflow_runtime | commands 交换机 | 两条 results 队列 |
| aigc_code_audit | 代码审查结果交换机 | 代码审查 requests 队列 |
| aigc_deployment | 部署结果交换机 | 部署 requests 队列 |

三者均无 configure 权限。审计账号不能写部署结果，不能通过默认交换机发布，也不应自动声明拓扑。

`--patch-api` 仅 merge patch 现有 `aigc-secrets` 的 `IntegrationConnections__CodeAudit__*` / `Deployment__*`：API 主机为 `aigc-mq:5672`、vhost=/aigc、运行账号 aigc_workflow_runtime；新操作 `review.requested` 映射到路由 code-audit.submit.v1，同时保留旧操作映射。保留 Secret 其他键，不修改 ConfigMap、不注入 Gitea 密钥。

如只创建拓扑暂不改 API 配置：去掉 `--patch-api`。配置生效由后续 API 镜像更新完成；单独修改配置后如需生效，再由运维执行 API rollout restart。

## 3. 持久化与恢复边界

脚本把运行 broker 的最新 definitions 与原 `aigc-mq-definitions` 合并，并仅更新该 Secret 的 definitions.json 键，避免新增资源在空 broker 恢复时丢失；不替换整个 Secret。保留全部原有业务资源。

每次执行会创建权限受限的 `workflow-mq-backup-*`：包含变更前 Service、两个 Secret（如 patch-api）、broker definitions 及恢复材料。**这些文件含敏感数据/哈希，不能发送给第三方或重新打入公共交付包。**

失败可能留下部分新资源。检查私有快照与 broker 后再重跑，使用同一组新业务密码；脚本不自动删队列或回滚密码。不要直接导入旧 definitions 充当业务消息回滚，它不会撤销已有消息。回退 API/Portal 镜像不删除业务队列或数据库字段。

## 4. 给第三方的连接信息

外部审查服务：`172.28.2.33:30672`、AMQP 0-9-1、`/aigc`、账号 `aigc_code_audit`，密码另行安全交付；集群内可使用 `aigc-mq.bosch-aigc-dsh.svc.cluster.local:5672`。

当前沿用既有明文 AMQP 监听，仅限受控内网并按来源限制网络访问；若需 TLS，由运维另行配置证书与监听后再交付 AMQPS 参数。现有管理 NodePort30242 不用作业务接口，不向审查方交付管理账号。

## 5. 应用更新后的配置和业务验收

在“第三方服务”登记/追加操作：

```json
{"code":"review.requested","resultEvent":"review.finished","protocol":"code-review-20261112"}
```

服务 code=`code-audit`，连接引用 `CodeAudit`。旧实例需要时保留 generic-v1 旧操作。新流程版本选择新操作，needs-review 连接人工复核任务；审批节点顺序由设计器决定。部署服务 code=`deployment`，连接引用 `Deployment`，操作 deploy.submit.v1/结果 deploy.completed.v1，协议 generic-v1。

Gitea 使用 `https://git.boschhuayu-steering.com`；复用第三方服务当前连接引用，OAuth Client ID/Secret 通过现有 aigc-secrets 注入，回调使用 `https://aigcplatform.boschhuayu-steering.com/admin/publications/gitea-callback`。不要把本地 GiteaLocal 的 HTTP 地址或 AllowInsecureHttp 带入生产；本工具不更换已有 Gitea 用户授权的连接引用。

```bash
kubectl -n bosch-aigc-dsh logs deployment/aigc-api -c api --since=10m | grep -E 'Integration|Workflow|代码审查' || true
```

登录验证 Gitea 仓库选择、固定 SHA、请求发送、Passed/Failed/Warning/Needs Review/取消/请求拒绝、重复结果去重及报告权限。连接/发布失败以调用记录和日志排查，不能只凭 Pod Running 判断业务通过。生产操作尚未由本地构建执行。
