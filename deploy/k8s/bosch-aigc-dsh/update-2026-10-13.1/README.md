# AIGC API / Portal 更新包 2026-10-13.1

本包包含 `aigc-api:2026-10-13.1` 和 `aigc-portal:2026-10-13.1`，架构 `linux/amd64`。配套 DSH 安装包为 `0.1.7-alpha.2.20261013.1`，单独交付。

本次新增未登录安装器的失败日志接收接口 `/v1/desktop/installer-diagnostics`，复用现有失败日志表；管理端失败日志支持“安装器”分类、阶段及权限错误上下文。现有认证客户端上报接口保持认证要求。接收接口包含字段与大小限制、脱敏、去重和限流。
API 启动时自动将失败日志表的 UserId 改为可空并创建匿名事件唯一索引，已有记录保留。无需手工执行 SQL。

以下节点信息依据仓库部署记录，执行前核对当前集群。仅在本机验证和打包，未自动部署生产环境。

## 1. 控制节点 172.28.2.26

上传 ZIP 后执行：

```bash
mkdir -p ~/aigc-update-2026-10-13.1
unzip ~/aigc-update-2026-10-13.1.zip -d ~/aigc-update-2026-10-13.1
cd ~/aigc-update-2026-10-13.1
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get deployments,pods -o wide
scp aigc-update-2026-10-13.1-linux-amd64.tar nj00663@172.28.2.33:~/
```

## 2. 工作节点 nj304 / 172.28.2.33

```bash
sudo ctr -n k8s.io images import --platform linux/amd64 ~/aigc-update-2026-10-13.1-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-13.1 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-13.1 >/dev/null
```

## 3. 返回控制节点

```bash
cd ~/aigc-update-2026-10-13.1
bash update.sh
kubectl -n bosch-aigc-dsh get pods -o wide
kubectl -n bosch-aigc-dsh logs deployment/aigc-api --tail=80
curl --fail https://aigcbackend.boschhuayu-steering.com/health
```

脚本校验包文件、目标节点镜像、调度约束和既有 PVC；备份部署、配置与数据库后依次更新 API、Portal。保留已有 CAS、LiteLLM、TLS 和持久化设置。SSH 账户不同时：`NJ304_SSH_TARGET=用户名@172.28.2.33 bash update.sh`。

## 4. 验收与回滚

使用具有 diagnostic.manage 权限的账户进入管理端失败日志，检查安装器分类。新版 DSH 安装失败后应显示安装阶段、错误码、安装目录及管理员状态。网络或企业证书信任异常时，检查客户端 `%LOCALAPPDATA%\wanzai\InstallerLogs` 中的 JSON 和 `.json.status`。本地记录不会自动重传。

```bash
cd ~/aigc-update-2026-10-13.1
bash rollback.sh "$(cat LAST_BACKUP)"
```

更新中途失败时使用脚本打印的备份目录运行 `bash rollback.sh backup-实际时间`。回滚只恢复镜像和部署字段，保留数据库新增字段兼容性及数据，不以旧 dump 覆盖新数据。旧 API 不接收匿名安装器日志。

本地验证详情见 verification.json；生产入口证书、Windows 安装器到生产 API 的链路和 Kubernetes rollout 仍需现场验证。
