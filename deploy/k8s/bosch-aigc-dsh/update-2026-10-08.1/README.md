# AIGC 2026-10-08.1 增量更新

适用于原部署：Kubernetes 命名空间 `bosch-aigc-dsh`，API/Portal/PostgreSQL/边缘 Nginx 位于 `bosch-k8s-node-nj304`（172.28.2.33），containerd 离线镜像导入。该环境信息来自仓库上次部署记录，执行前核对实际集群。

镜像包仅包含 `aigc-api:2026-10-08.1`、`aigc-portal:2026-10-08.1`，Linux amd64。没有 Windows DSH 安装包；客户端变更需要单独打包并通过灰度页面发布。

## 1. nj304 导入镜像

将本目录上传到服务器（例如 `~/aigc-update-2026-10-08.1`），将 tar 上传到 nj304 的同一目录。在 nj304 执行：

```bash
cd ~/aigc-update-2026-10-08.1
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import aigc-update-2026-10-08.1-linux-amd64.tar
sudo ctr -n k8s.io images ls | grep -E 'aigc-(api|portal):2026-10-08.1'
```

两个新镜像必须均已导入。更新脚本保留原 imagePullPolicy Never 和节点选择器，因此不访问远程镜像仓库。

## 2. master 核对现有部署

把 update.sh、rollback.sh、api-update.patch.json 和 README.md 同步上传到具有 kubectl 权限的 master。

```bash
kubectl config current-context
kubectl -n bosch-aigc-dsh get deployment,pods,pvc -o wide
kubectl -n bosch-aigc-dsh get deployment aigc-api aigc-portal -o wide
kubectl -n bosch-aigc-dsh get pv bosch-aigc-dsh-uploads -o yaml
```

确认命名空间、nj304 节点和 uploads 卷符合原部署。服务器需要 Python 3。安装包与现有附件共享 uploads PVC 容量；发布前确认 nj304 对应持久磁盘有足够空间。保留旧镜像以便回滚。

## 3. master 执行更新

```bash
cd ~/aigc-update-2026-10-08.1
bash update.sh
```

脚本会先检查 uploads PVC 为 Bound 且 API 正在使用该卷；备份当前 Deployment、Nginx 配置、旧镜像名及 PostgreSQL 数据库到本目录下 backup-时间目录。数据库备份失败会停止更新。备份含业务数据，应限制访问并另行保存。

随后执行：

- API 切换新镜像，安装包存储显式配置到 `/var/lib/aigc-hub/desktop-releases`，使用现有 `aigc-dsh-uploads` PVC 的 `desktop-releases` 子目录。无需新建 PV/PVC；Pod 重建后文件仍保留。
- API 首次启动自动添加公告、客户端版本、回执、上报表及 AudienceJson 字段，不清空现有数据。
- Portal 切换新镜像；前端 API 地址已在构建时设置为 `https://aigcbackend.boschhuayu-steering.com`。
- 在当前运行的 Nginx 配置上只调整上传大小为 2100m，保留 TLS、静态试点更新源及其他现有配置；重启边缘 Pod 使 subPath 配置生效。

保留现有 PostgreSQL、Secret、TLS 证书、LiteLLM/CAS 参数与数据保护密钥。此次无需执行旧 README 的首次部署步骤，也不要重新创建数据库或套用旧版完整 kustomization。

如果旧版 API 曾经在容器内部上传过安装包，请先将那些文件迁移到持久卷，再更新；本脚本无法恢复已经丢失的临时容器文件。

## 4. 验证

```bash
kubectl -n bosch-aigc-dsh logs deployment/aigc-api --tail=100
curl -f https://aigcbackend.boschhuayu-steering.com/health
```

`curl` 使用信任企业 CA 的机器，不以关闭证书验证代替正确配置。health 只代表 API 响应，还需执行以下功能验证：

1. 退出并重新登录管理员，确认可见公告管理与客户端灰度发布。
2. 确认原用户、部门、角色、模型及虚拟 Key 数据仍在，原登录/聊天/模型调用正常。
3. 新增草稿公告，选择一个测试用户并发布；新版 DSH 内部显示公告，阅读/确认回执正常。
4. 上传新的 unsigned exe 和对应 blockmap，选择一个测试用户发布；用户可更新，非目标用户无更新。
5. 验证公告、回执、版本、上报分页和操作栏，以及操作审计默认每页 10 条。
6. 维护窗口内重建 API Pod，确认已上传安装包仍可下载，检验持久化。

DSH 基础版必须包含本次更新功能；需要手动安装一次新的未签名基础版本，然后测试更高版本自动升级。服务镜像不改变已安装的 Windows 客户端。

## 5. 回滚

```bash
bash rollback.sh backup-实际时间目录
```

回滚脚本使用备份的实际旧镜像名恢复 API/Portal，并恢复旧 Nginx 配置。保留新增数据库表、安装包目录及上线后的业务数据，不自动覆盖数据库。数据库备份仅用于灾难恢复，恢复前应单独确认对新数据的影响。

## 验证范围

本包在本机完成 Linux 镜像构建与隔离容器验证；服务器上的部署状态和真实 Windows 升级仍由上线步骤验证。镜像 SHA256 与离线包校验见 SHA256SUMS。
