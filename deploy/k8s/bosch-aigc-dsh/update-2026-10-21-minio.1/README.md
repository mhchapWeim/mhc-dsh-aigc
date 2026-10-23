# 2026-10-21 MinIO 离线更新

目标：Kubernetes v1.28 / containerd，namespace `bosch-aigc-dsh`，工作节点 `bosch-k8s-node-nj304`（172.28.2.33），linux/amd64。这是本地构建交付，未连接或更新生产集群。

## 本次内容

- API `aigc-api:2026-10-21-minio.1`：MinIO 云端备份、分片上传、续传、SHA-256 校验、Range 下载、选择恢复所需接口。旧数据库 JSON 备份仍可读取，不自动迁移历史数据，无数据库结构迁移。
- Portal `aigc-portal:2026-10-21-minio.1`：模型管理布局、新备份归档下载。编译期 API 地址 `https://aigcplatform.boschhuayu-steering.com`。
- MinIO `aigc-backup-minio:2025-06-13-offline.1`：镜像源 `quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z`，本地镜像标识记录在 BUILD-INFO.json。S3 与初始化 mc 均包含在镜像内，不需要额外联网拉取工具。
- `update.sh`、预检脚本、`verify.sh`、`rollback.sh`、22 项脚本测试、校验清单。

本包不含 DSH Windows 安装器。分片上传和勾选恢复需要包含本轮改动的新版 DSH；旧安装器不会因 API 更新而自动获得新能力。客户端模型恢复、插件更新提示及下拉框样式修复也需要重新构建/安装 DSH。

构建使用 main 当前工作区快照，包含未提交的功能改动；不等同于远端 main 已提交版本。源码清单与散列记录在 BUILD-INFO.json。本地 appsettings.Development.json 中的 MinIO 密钥已从构建上下文移除。

## 1. 传输与导入（nj304 Bash）

将完整 ZIP 解压到控制节点，并将镜像 TAR 传到 nj304。不要只传脚本。校验后在 nj304 导入到 `k8s.io`，不是在 master 导入：

```bash
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import --platform linux/amd64 aigc-images-2026-10-21-minio.1-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-21-minio.1 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-21-minio.1 >/dev/null
sudo crictl inspecti docker.io/library/aigc-backup-minio:2025-06-13-offline.1 >/dev/null
```

所有新 Pod/Job 使用 `imagePullPolicy: Never`。必须导入三个镜像，保留原有 API/Portal 镜像以便回退。更新脚本保留现有已知 initContainer，其旧镜像也须仍在 nj304。

## 2. 预检（控制节点 Bash）

确认 `kubectl config current-context`、目标节点和 namespace 正确。控制节点需 python3、kubectl、curl、flock、timeout，以及可 SSH 到 nj304 并执行 sudo 的账号。

```bash
kubectl config current-context
kubectl -n bosch-aigc-dsh get deploy,pod,pvc -o wide
kubectl get node bosch-k8s-node-nj304 -o wide
CHECK_ONLY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

预检读取并私下保存现有 Deployment、ConfigMap、Secret，检查新域名、持久卷、已知 envFrom/initContainer、单 API 副本、镜像和资源服务端 dry-run。不会创建 MinIO、Secret、目录或更新 Pod。快照目录权限受 umask 077 保护，含生产凭据，不得发回公共聊天或提交 Git。

本地 PV 固定 `/var/lib/aigc-hub/minio-backups`、100Gi、Retain，固定 nj304。部署前在 nj304 确认该路径所在磁盘有足够空间、用于本项目且没有其他 MinIO 实例的数据；首次部署建议选择独立空目录。更新脚本创建目录，不清空数据。已有 PV/PVC/Secret 会先检查再复用；不覆盖其他目录或重建数据卷。100Gi 是卷声明，不是目录硬配额；需监控实际磁盘。

## 3. 更新（控制节点 Bash）

```bash
NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

首次部署按用户指定默认创建管理账号 `admin` / `admin@1234`，应用账号自动随机生成，均存入 K8s Secret `aigc-backup-minio`，不写入镜像。已存在 Secret 则保留，不重置密码。也可在首次执行前设置 `MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD` 覆盖默认值。应用使用独立最小权限账号，不使用 root。

顺序：私有配置快照→可选数据库 dump→持久目录/Secret→PV/PVC/MinIO Deployment/内部 Service→初始化私有桶与应用账号 Job→API 镜像及 MinIO env→Portal 镜像→验证。当前版本无结构迁移，默认不做数据库 dump；如需，使用 `BACKUP_DATABASE=1 ... bash update.sh`，300 秒超时并显示进度。不会还原或覆盖现有数据库数据。

完成后记录输出的 `backup-*` 目录，包含回退配置和首次生成的 Secret。脚本失败会停止并输出位置，不自动清理数据。

## 4. 验证与验收

```bash
bash verify.sh "$(cat LAST_BACKUP)"
kubectl -n bosch-aigc-dsh get pod,pvc,svc -o wide
kubectl -n bosch-aigc-dsh logs deployment/aigc-api --since=10m
```

企业 CA 需要显式指定时使用 `CA_FILE=/path/to/enterprise-ca.pem bash verify.sh ...`，不默认跳过 TLS 校验。脚本检查新镜像与 Never、rollout、MinIO 桶、HTTPS 健康/SSO 配置和页面。可用环境变量 `DSH_ACCESS_TOKEN` 增加授权 limits 检查；不要把令牌写在 URL、脚本或聊天中。

业务验收必须使用新版 DSH：登录→云端备份刷新不再 503→选小会话上传→暂停后重试/客户端重启续传→恢复勾选会话→确认原历史保留。再测试全选、跨账号拒绝、旧备份恢复及生产真实断网。小数据冒烟不代表 1GiB 压测、生产 SSO 或真实双设备验收通过。

MinIO 不开放公网/NodePort。临时查看控制台，在有 kubeconfig 的电脑执行：

```bash
kubectl -n bosch-aigc-dsh port-forward deployment/aigc-backup-minio 19001:9001
```

同一电脑打开 `http://127.0.0.1:19001`。若在远程控制节点执行，还需 SSH 隧道；本机 localhost 不会自动指向远程主机。

## 配置维护

- 配置在 API Deployment 的 `BackupStorage__*` env；Secret `aigc-backup-minio` 保存 `root-user`、`root-password`、`access-key`、`secret-key`。DSH 不配置或直连 MinIO。
- 默认单次 1GiB、账号 10GiB、分片 8MiB、上传任务保留 168 小时。增加容量可使用 `kubectl -n bosch-aigc-dsh set env deployment/aigc-api BackupStorage__MaximumBytes=... BackupStorage__AccountQuotaBytes=...`，等待 rollout。分片当前允许 5–16MiB，单次上限不超过分片×10000；配额须不小于单次上限。
- 修改 Secret 后进程不会自动刷新环境变量；需先同步 MinIO 实际账号/权限，再更新 Secret 并重启相关 Pod。单独改应用密钥 Secret 不会自动创建对应 MinIO 用户。管理凭据需更改 Secret 后重启 MinIO；应用凭据还需更新 MinIO 用户并重启 API。
- 已有对象后不可直接换 Endpoint/Bucket，否则旧备份找不到；需要保留对象 key 的数据迁移并核对元数据。重新运行本更新脚本会恢复本版本默认容量配置，后续调参应纳入新的部署配置包。
- 本版本配额锁/清理面向单 API 副本，MinIO 是单节点持久化实例，不提供高可用。数据库元数据与 MinIO 对象应成套备份。

## 回退

```bash
bash rollback.sh backup-实际目录
```

恢复原 API/Portal 镜像、拉取策略和 API env；不回退数据库，不删除 MinIO Deployment、Secret、PV、PVC 或对象。保留新备份，回退旧 API/客户端后可能暂时无法读取新格式；重新部署兼容版本再恢复。若在 API patch 前失败，原 API/Portal 仍保持原镜像，按日志修复 MinIO 后重新预检。不要用删除卷或覆盖数据库来回退。
