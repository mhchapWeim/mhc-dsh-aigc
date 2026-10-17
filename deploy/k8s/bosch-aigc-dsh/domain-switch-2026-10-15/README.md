# 域名更换与镜像更新包

本次按用户最新要求提供 `update.sh`，执行方式与此前离线更新一致。目标为 `https://aigcplatform.boschhuayu-steering.com`，节点仍是 nj304（172.28.2.33），命名空间仍是 `bosch-aigc-dsh`。

## 包含内容

- `update.sh`：检查、备份、更新、滚动等待和 HTTPS 验证。
- `rollback.sh`：恢复变更前 ConfigMap、API/Portal 镜像、环境变量和 Nginx 挂载。
- `verify.sh`、`prepare.py`：验证及基于现场快照生成定点补丁；只需要系统 Python 3 标准库。
- `tls/fullchain.crt`：你提供的新域名证书及从匹配 PFX 提取的 CA 链。
- `tls/tls.key`：已验证与证书配对的 PEM 私钥，供 Nginx 无交互加载。
- `tls/ca-chain.crt`：从 PFX 提取的企业 CA，供本次 curl 验证使用，不安装到系统。
- `artifacts/aigc-domain-images-linux-amd64.tar`：已构建的 API/Portal 离线镜像，160938496 字节。
- 镜像：`docker.io/library/aigc-api:2026-10-15-domain.1` 和 `docker.io/library/aigc-portal:2026-10-15-domain.1`。

压缩包包含私钥，请仅通过内部安全渠道传输，解压目录保持私有。无需上传 PFX 或密码说明文件；脚本不输出私钥和密码。Portal 镜像已编译为新 API 地址，镜像内 JS/HTML 已检查不含旧 API 地址，本地启动 `/login/local` 返回 200。镜像包含当前工作区的云端备份和客户端下载功能，API/Portal 需要一起更新。

## 为什么使用两个 TLS Secret

已读取你提供的文件：新证书 SAN 只覆盖 `aigcplatform.boschhuayu-steering.com`，有效期至 2028-10-14。CRT、KEY 和 PFX 的证书/公钥已核对一致；PFX 包含一张企业根 CA。

仓库旧证书只覆盖 `aigcbackend`。因此不能将新证书直接覆盖旧 Secret，否则旧客户端访问旧域名会证书不匹配。

脚本保留 `aigc-edge-tls`，创建 `aigc-platform-tls`。443 的 edge 和 30443 的模型代理各增加新证书挂载与新域名 SNI server。旧 API、旧客户端和历史更新文件仍可访问；旧网页入口跳转到新域名。无需重建 Nginx 镜像、不更换 IP、不迁移数据库，也不重建 PVC。

## 现场前提

1. 两个域名继续解析到 172.28.2.33。
2. 企业 CAS 已允许新 service：`https://aigcplatform.boschhuayu-steering.com/v1/auth/cas/callback`，包括 Portal 使用的 `portal_state` 查询参数。确认后才设置 `CAS_READY=1`。
3. 在维护窗口执行。edge/API 可能使用 Recreate，更新期间有短暂中断，进行中的登录需要重试。
4. 控制节点具备 kubectl、python3、openssl、curl、ssh、sha256sum；具备命名空间读取、更新权限和到 nj304 的 SSH/sudo 权限。
5. 目标资源名称、容器名和节点选择与 DEPLOYMENT-RUNBOOK.md 一致。脚本读取现场配置，遇到额外 envFrom、间接域名变量、未知 TLS 路径或已存在的新域名配置会停止，不覆盖猜测值。
6. 不与其他运维变更同时执行。回退会恢复备份中的配置。

## 第一步：上传与导入镜像（nj304）

将完整压缩包传到 nj304 和控制节点，安全解压。本示例解压目录为 `/opt/aigc-domain/domain-switch-2026-10-15`。在 nj304 Bash 执行：

```bash
umask 077
cd /opt/aigc-domain/domain-switch-2026-10-15
sha256sum -c SHA256SUMS
cd artifacts
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import --platform linux/amd64 aigc-domain-images-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-15-domain.1 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-15-domain.1 >/dev/null
```

原镜像和原文件保留。离线部署使用 imagePullPolicy Never，必须先导入实际运行节点，不能只放到控制节点。

## 第二步：检查（控制节点）

同一完整包也解压到控制节点。在控制节点 Bash 执行：

```bash
umask 077
cd /opt/aigc-domain/domain-switch-2026-10-15
chmod 700 .
chmod 600 tls/tls.key
CHECK_ONLY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

此模式会检查校验值、证书、新私钥配对、节点镜像、现场资源与候选 Nginx 语法，并在本地生成私有快照及补丁，不修改集群。SSH 账号不同则修改 NJ304_SSH_TARGET。

## 第三步：执行更新（控制节点）

```bash
CAS_READY=1 NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

更新前保存 Deployment、ConfigMap、旧 TLS Secret、已有新 TLS Secret和数据库 pg_dump，目录为 `backup-时间`，`LAST_BACKUP` 记录本次变更前备份。备份含敏感信息，仅限运维访问。数据库备份失败会在实际变更前停止。

脚本只修改：

- 新域名 TLS Secret、两个 Nginx ConfigMap 及新证书挂载。
- Cas__PublicBaseUrl、Cas__PortalBaseUrl、Cas__ServiceUrl。
- 增加新旧域名 CORS，保留已有的其他来源；同时处理 Deployment 的显式覆盖。
- 若当前 LiteLlm__PublicBaseUrl 使用旧域名，替换其中的主机名，保留端口和路径；若当前是其他内部直连地址，保留原值。
- API、Portal 镜像为本次已导入版本。

不修改 LiteLlm__BaseUrl、Bocha 上游、数据库连接、JWT 密钥、DataProtection 或已有数据卷。脚本不执行生产 DNS、企业 CAS 注册或桌面安装包发布。

## 第四步：验收

脚本会验证新域名健康接口、SSO 开关、本地登录页面、旧域名健康接口及网页跳转。若模型公共地址使用新域名 30443，还会检查代理 healthz。验证使用包内企业 CA，未关闭 TLS 验证。如现场 CA 链不同，可通过绝对路径 CA_FILE 覆盖：

```bash
CA_FILE=/实际路径/enterprise-ca.pem CAS_READY=1 bash update.sh
```

只重新验证，无需再次更新：

```bash
bash verify.sh "$(cat LAST_BACKUP)"
```

用户电脑仍需信任企业 CA，包内 curl 的 CA_FILE 不会改变用户电脑信任。浏览器访问新域名，完成真实 SSO，确认 Network 中 Portal API 请求、CAS service 和回跳均使用新域名；域名变化后需要重新登录。继续验证客户端下载、模型流式结果和会话备份上传恢复。旧 DSH 应继续能登录和调用接口。

脚本会拒绝在已添加新 SNI 配置的集群重复更新，以免备份变成更新后的状态。失败时先检查日志和备份，按下节回退，再重新更新。只有 HTTPS 基础检查通过不等于上述业务已验收。

## 回退

```bash
cd /opt/aigc-domain/domain-switch-2026-10-15
bash rollback.sh "$(cat LAST_BACKUP)"
```

也可以明确指定 `backup-YYYYMMDD-HHMMSS`。回退恢复 ConfigMap、API/Portal 原镜像与域名 env、Nginx 原卷和挂载。旧 TLS Secret 从未被覆盖；如果新 Secret 之前存在，则恢复其原内容，新建但已无引用的 Secret 留存供检查，不主动删除。

不恢复旧数据库覆盖新数据，不删除 PV/PVC，不清理原镜像；新增的兼容表可保留。若期间发生其他人的配置修改，先人工合并，不能直接用旧快照覆盖。

## 后续客户端与发布

本包不含 DSH 新安装器。旧客户端通过保留的旧 API 地址使用；后续打包将 `apps/desktop/.env.windows` 中的 DSH_DESKTOP_MANAGED_BACKEND_URL 设置为新域名。不要运行旧 update-2026-10-14.* 包将域名配置写回旧值。

目前只完成本地构建、证书配对、脚本和隔离配置验证，未连接生产集群部署，也未完成企业 CAS/两台真实电脑业务验收。

## 本地验证证据

3 项配置生成测试通过，三个 Bash 文件语法检查通过。使用已有 edge Nginx 镜像进行隔离验证：443 和 8443 的新旧域名 TLS 握手均通过企业 CA 和主机名验证，并返回对应 SAN；旧网页返回 308；新旧模型代理 healthz 均为 200。测试没有连接生产 API，上游占位地址导致新网页 502 属于隔离环境预期，不能视作线上业务验收。测试容器已清理。

## 2026-10-15 Nginx 检查修复

现场 CHECK_ONLY 曾在 nginx -t -c /dev/stdin 报 no events section；这是 Nginx 再次读取配置时标准输入已到末尾造成的检查方式错误，不能据此判断现场缺少 events。已改为在 Pod 内 mktemp、接收候选配置、nginx -t 检查后 trap 清理。没有修改在线 Nginx 配置。原问题已在本地相同 edge 镜像复现；修复后有效配置通过、无效配置拒绝、临时文件清理均验证通过。

已上传旧包时，在原解压目录解压小修复包覆盖 update.sh、README.md、SHA256SUMS，重新运行 CHECK_ONLY；镜像和证书无需重传。CHECK_ONLY 失败不需要回滚集群配置；原本地备份目录保留私密保存。
