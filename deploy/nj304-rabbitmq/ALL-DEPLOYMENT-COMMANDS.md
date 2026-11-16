# nj304 MQ、Secret、ConfigMap 联合交付命令

在 Kubernetes 控制节点 Bash、解压后的本次交付目录执行。复用现有 namespace `bosch-aigc-dsh`、MQ `aigc-mq`、vhost `/aigc`、NodePort `30672/30242`。不 apply 仓库旧 RabbitMQ/ConfigMap YAML。

## 1. 校验及只读检查

```bash
set -euo pipefail
umask 077
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get svc aigc-mq -o wide
kubectl -n bosch-aigc-dsh get pods -l app=aigc-mq -o wide
kubectl -n bosch-aigc-dsh describe secret aigc-mq-definitions
kubectl -n bosch-aigc-dsh describe secret aigc-secrets
kubectl -n bosch-aigc-dsh get configmap aigc-settings -o name
kubectl -n bosch-aigc-dsh get deployment aigc-api -o jsonpath='{.spec.template.spec.containers[?(@.name=="api")].envFrom}'
python3 mq/configure-workflow.py > workflow-plan.json
```

## 2. 一条命令创建 MQ 业务环境，同时修改 Secret 和 ConfigMap

```bash
python3 mq/configure-workflow.py --apply --patch-api --patch-configmap
```

脚本交互读取现有 MQ 管理员密码和三个新业务账号密码，不把密码写到命令参数或终端输出。

执行内容：

- 在现有 `/aigc` 增量创建业务交换机、quorum 队列、绑定、账号、最小权限、TTL/容量/死信策略；新审查结果绑定 `review.finished` 和 `review.rejected`，保留旧事件绑定。
- 合并现有 `aigc-mq-definitions` Secret 的 `definitions.json`，保留原业务和实时 broker 定义。
- merge patch 现有 `aigc-settings` ConfigMap：`IntegrationConnections__CodeAudit__*`、`IntegrationConnections__Deployment__*` 的非敏感 MQ 参数，包括内部地址 `aigc-mq:5672`、`/aigc`、Enabled、账号、交换机、结果队列和操作路由。
- merge patch 现有 `aigc-secrets` Secret：仅写入两项 `IntegrationConnections__CodeAudit__Password`、`IntegrationConnections__Deployment__Password`；从该 Secret 删除刚移入 ConfigMap 的同名非敏感键，避免 Secret 的 envFrom 优先级遮蔽 ConfigMap。保留其他键，包括 Gitea、CallbackSecret、SSO、数据库配置。
- 变更前在私有 `workflow-mq-backup-*` 目录保存现有配置。目录含凭据，不发送给第三方，不重新打入交付包。

没有任何自动重启，不改变 Service、NodePort、RabbitMQ Deployment、PV/PVC。脚本要求 API 已通过 envFrom 引用这两个现有对象；若发现显式 env 覆盖本业务配置会停止。集群修改不是事务，失败后检查私有备份及实际配置，用同一组密码重试，不删队列。

如只创建 MQ：`python3 mq/configure-workflow.py --apply`。
如仍需全部 MQ 参数保存在 Secret：`python3 mq/configure-workflow.py --apply --patch-api`。
以上是可选方式，不需要依次执行三遍。

## 3. 等价 kubectl 修改命令（用于复核/故障后重试）

上面的联合脚本已执行以下命令，正常成功后无需重复。将路径替换成该次脚本输出的实际私有备份目录，不要选择旧轮次：

```bash
TASK_BACKUP=./workflow-mq-backup-实际后缀
test -f "$TASK_BACKUP/boot-definitions.patch.json"
test -f "$TASK_BACKUP/settings.patch.json"
test -f "$TASK_BACKUP/api.patch.json"
kubectl -n bosch-aigc-dsh patch secret aigc-mq-definitions --type=merge --patch-file "$TASK_BACKUP/boot-definitions.patch.json"
kubectl -n bosch-aigc-dsh patch configmap aigc-settings --type=merge --patch-file "$TASK_BACKUP/settings.patch.json"
kubectl -n bosch-aigc-dsh patch secret aigc-secrets --type=merge --patch-file "$TASK_BACKUP/api.patch.json"
```

不使用 `kubectl apply -f configmap.yaml` 或 `secret.example.yaml` 覆盖现场配置。

## 4. 配置生效及镜像更新

完成 nj304 镜像导入后，在控制节点按 README 执行：

```bash
CHECK_ONLY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
bash verify.sh
```

本次镜像更新会创建新 Pod 并读取新 ConfigMap/Secret，不需要另外重启 MQ 或 Portal。若已经是本次镜像、仅修改配置，由运维单独执行 API 重启：

```bash
kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-api
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=180s
```

可在 API 容器检查两个配置来源是否都已读取，不打印密码：

```bash
kubectl -n bosch-aigc-dsh exec deployment/aigc-api -c api -- sh -ec '
test "$IntegrationConnections__CodeAudit__HostName" = aigc-mq
test "$IntegrationConnections__CodeAudit__Port" = 5672
test "$IntegrationConnections__CodeAudit__VirtualHost" = /aigc
test -n "$IntegrationConnections__CodeAudit__Password"
test -n "$IntegrationConnections__Deployment__Password"
echo "Workflow MQ settings/passwords are present"
'
```

Gitea OAuth 配置沿用现场当前连接引用；此 MQ 命令不创建 OAuth 应用、不覆盖已有授权和 SSO。第三方服务登记、新操作及流程版本发布仍按 MQ-DEPLOYMENT.md 第5节在管理页面完成。真实服务验收未执行。
