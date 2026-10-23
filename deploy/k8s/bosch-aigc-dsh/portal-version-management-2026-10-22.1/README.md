# 版本管理 · Portal 单独更新包

仅更新 `bosch-aigc-dsh` 命名空间的 `aigc-portal` Deployment 中 `portal` 容器镜像，滚动替换前端 Pod。无需更新 API、LiteLLM、数据库、DSH 或插件，不修改 ConfigMap、Secret、环境变量、存储卷，也不运行数据库迁移。单纯重启旧镜像 Pod 不会获得本次修改。

镜像：`aigc-portal:2026-10-22-version-management.1`，平台 `linux/amd64`。编译期 API 地址为 `https://aigcplatform.boschhuayu-steering.com`。本包在本地构建验证，未执行生产部署；现场 Deployment 由更新脚本读取后生成镜像定点补丁。

界面修改：客户端运维 → 版本管理 → 版本发布/版本状态；版本状态支持人员、工号、电脑名、设备 ID 搜索及版本/更新状态组合过滤，显示设备 ID 和最近上报时间，筛选区复用管理页面样式，版本管理不显示前置图标。

镜像基于 main 当前 Portal 工作区快照，包含此前已有的模型管理布局、备份页面及 API 客户端改动；不是从旧镜像抽取的单项补丁。本包只替换前端镜像，不包含 API、客户端或数据库更新。

## 1. 导入镜像（nj304）

将本包解压到 nj304 和有 kubectl 的控制节点。以下假设解压目录为 `/opt/aigc/portal-version-management-2026-10-22.1`。在 nj304 执行：

```bash
cd /opt/aigc/portal-version-management-2026-10-22.1
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import --platform linux/amd64 artifacts/aigc-portal-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-22-version-management.1 >/dev/null
```

保留旧 Portal 镜像供回滚。离线镜像必须导入实际运行节点的 `k8s.io` 命名空间；仅将文件放在控制节点上不够。本包预检要求现有 nodeSelector 固定为 `bosch-k8s-node-nj304`，节点不同会停止。

## 2. 预检（控制节点）

```bash
cd /opt/aigc/portal-version-management-2026-10-22.1
CHECK_ONLY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

需要 kubectl、python3、ssh、curl、sha256sum，以及现有集群权限和到 nj304 的 SSH/sudo 权限。SSH 账号不同请修改 `NJ304_SSH_TARGET`。预检保存私有 Deployment 快照、验证目标容器和节点、检查节点镜像，并执行服务端 dry-run，不修改集群。不要与其他 Deployment 运维变更同时执行；资源版本变化会使更新停止。

## 3. 更新与验证（控制节点）

```bash
NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

脚本保存变更前快照及回滚补丁，只修改 Portal 镜像和离线拉取策略，等待新版本 rollout 并检查正式 HTTPS 的 `/login/local` 与 `/desktop`。本次没有数据变更，不执行数据库备份/恢复。备份目录由 `LAST_BACKUP` 记录，可能包含 Deployment 环境变量，请按运维敏感文件保管。

登录后进入“客户端运维 → 版本管理”，检查版本发布和版本状态独立显示；验证搜索、版本/状态筛选、重置、分页、设备 ID 与最近上报时间，以及筛选区样式和菜单无前置图标。浏览器若仍显示旧页面，请强制刷新。

可单独再次运行 `bash verify.sh`。HTTPS 页面可达不能替代登录后的业务界面验收。

## 4. 回滚

```bash
bash rollback.sh "$(cat LAST_BACKUP)"
```

只恢复此前 Portal 镜像和拉取策略；若现场镜像已被其他更新替换，回滚补丁会停止，避免覆盖后续部署。回滚需要旧镜像仍存在于目标节点。

## 本地验证

详见 `VERIFICATION.json` 和 `evidence/`。本地自动测试与镜像公开页面冒烟不能替代登录后的现场业务验收。本次未执行生产预检或部署。
