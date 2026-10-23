# AIGC API / Portal 离线更新（app-only）

本包替代 `aigc-update-2026-10-23-main.1.zip`。仅更新 API 和 Portal 镜像及 imagePullPolicy，目标 namespace `bosch-aigc-dsh`、节点 `bosch-k8s-node-nj304`、linux/amd64。

保留现有 MinIO、PV/PVC、Service、Secret、目录和数据；不含 MinIO 镜像、资源清单、初始化或启动操作。API 原有 env/envFrom（包括全部 BackupStorage__* 和 Secret 引用）、卷、节点约束原样保留。回退也只恢复两个应用镜像及拉取策略。不会修复既有 MinIO 节点位置或备份配置问题。

## 1. nj304 导入镜像

把本 ZIP 解压目录传到 nj304，在该目录执行：

```bash
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import aigc-images-2026-10-23-main.1-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-23-main.1 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-23-main.1 >/dev/null
```

旧镜像保留供回退。仅在 nj304 的 containerd k8s.io 命名空间导入。

## 2. 控制节点预检和更新

控制节点需 kubectl 权限及 python3（3.9+）、ssh、curl、sha256sum、flock、timeout；能 SSH 到 nj304 执行 sudo crictl。将相同解压目录传到控制节点，在目录中执行：

```bash
CHECK_ONLY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
bash verify.sh
```

按实际账户修改 SSH 目标；不要改为其它节点。企业 CA 如未进入系统信任，设置 `CA_FILE=/path/to/ca.pem`，保持 TLS 校验。

预检只读取并保存私有快照、执行服务器 dry-run；检查既有新域名、已知配置来源、initContainer、持久卷和 nj304 节点约束。未知配置会停止，不覆盖现场。快照包含 Secret，权限由 umask 077 限制，不要公开发送。更新先 API，再 Portal；如中途失败，保留备份并提示回退，不自动覆盖现场。

本轮没有数据库结构迁移，默认不做数据库 dump。需要时在实际更新命令前设置 `BACKUP_DATABASE=1`，会限时导出 PostgreSQL 自定义格式。配置和旧镜像快照始终保存。

## 3. 验收与回退

verify.sh 检查两个应用 rollout、目标镜像、HTTPS 健康、SSO 配置、登录和客户端下载页、日志目录可写。请另外验收企业 SSO、旧客户端、附件登记、已有备份的上传/续传/恢复，再安装或发布新版 DSH。现有 MinIO 异常可能影响备份验收，本包不会修改该服务。

```bash
bash rollback.sh backup-实际目录
```

备份目录可从 LAST_BACKUP 查询。回退只恢复 API/Portal 镜像及拉取策略；检测到第三方镜像变更则停止。数据和配置不回退。请保留旧镜像，回退后重新完成业务验收。

## 4. MinIO 节点问题的只读核对

用户反馈昨天实例运行于其它服务器；尚未连接生产核验。仓库旧模板中 Deployment nodeSelector 和 local PV nodeAffinity 指向 nj304，不能据此认定线上资源相同。可在控制节点查看：

```bash
kubectl -n bosch-aigc-dsh get pods -o wide
kubectl -n bosch-aigc-dsh get deployment aigc-backup-minio -o yaml
kubectl -n bosch-aigc-dsh get pvc -o wide
kubectl get pv aigc-backup-minio -o yaml
kubectl get nodes -L kubernetes.io/hostname
```

PV 名称以 PVC 实际绑定为准。迁移前必须确认真实数据所在节点、路径与备份，不直接修改节点约束或删除卷。本轮不执行迁移。

## 5. 本地验证范围

复用本轮已构建并验证的相同 API/Portal 镜像；源码清单、散列、镜像标识见 BUILD-INFO.json。此前隔离测试结果见 verification.json，临时测试 MinIO 仅用于本机应用测试。app-only 预检共 16 项，覆盖既有备份明文配置、Secret 引用和 envFrom 的保留，且所有变更补丁路径限定为两个应用的 image/imagePullPolicy。Bash 语法、归档结构和校验清单均验证。

未执行生产预检或部署。DSH 安装包仍为 `0.1.7-alpha.2.20261023.2`，不因本次部署范围调整重建。
