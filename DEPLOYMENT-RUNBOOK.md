# DSH、AIGC 和 Portal 部署记录

## 2026-10-23 AIGC / DSH 当前工作区构建交付

本次使用 `main` 当前工作区（包含未提交改动），未连接或更新生产服务器。API/Portal 来自独立构建快照，源码清单、散列、镜像标识与开发配置脱敏处理见交付目录的 `BUILD-INFO.json`。

- 服务端修订离线包：`output/aigc-update-2026-10-23-main.1-app-only.zip`；配套校验文件同名 `.zip.sha256`。交付目录 `deploy/k8s/bosch-aigc-dsh/update-2026-10-23-main.1-app-only`，只含 API/Portal `2026-10-23-main.1` 两个镜像和 update/verify/rollback、预检、README、校验清单。目标 nj304/containerd、namespace `bosch-aigc-dsh`、linux/amd64。按用户修正，本次不部署或操作 MinIO，保留现有 API BackupStorage 环境配置、Secret 引用及存储资源。**此前同日包含三个镜像的 `aigc-update-2026-10-23-main.1.zip` 已被替代，本次不要使用。** 执行命令见[本次部署说明](deploy/k8s/bosch-aigc-dsh/update-2026-10-23-main.1-app-only/README.md)。
- DSH Windows x64 未签名内部包：`output/dsh-main-0.1.7-alpha.2.20261023.2-win-x64.zip`，安装器和元数据另存于 `output/dsh-main-0.1.7-alpha.2.20261023.2`。已检查最终 ASAR 中生产后端 `https://aigcplatform.boschhuayu-steering.com`、完整版本、附件信息登记实现、主进程依赖内联和更新地址；EXE 的 SHA-512 与 nightly.yml 一致，blockmap 覆盖字节与安装器一致。Authenticode 状态为 NotSigned。

本次包含附件审查只记录信息、旧客户端登记/续传兼容、模型及客户端版本管理页面、MinIO 会话备份、客户端模型恢复和插件更新等当前源码改动。**先部署 API 和匹配 Portal 并验收，再安装或发布新版 DSH。** 旧客户端保留兼容；历史完整附件仍按权限下载。详细语义见[附件兼容说明](docs/DSH-ATTACHMENT-METADATA-COMPATIBILITY.md)。无本轮新增数据库列，不执行历史附件批量转换。

本地后端 31 项、Portal 44 项、DSH 功能 39 项、安装打包 8 项通过；修订 app-only 部署脚本预检 16 项通过。新镜像隔离运行的健康/四个页面 HTTP 200，真实 PostgreSQL + MinIO 的两片上传、续传状态、SHA-256 完整下载、Range 206、删除和应用账号管理权限拒绝通过。Portal 257 个 JS/HTML 文件未发现旧 API 域名。DSH 最终 ASAR 的原生工具、工作区控制器与 DOCX/XLSX/PPTX 转 PDF 冒烟通过。

首次 DSH 封装被沙箱 pnpm SQLite 缓存访问阻断；宿主环境重新构建成功。未上传或发布 DSH、未实际安装到用户设备、未执行生产 CHECK_ONLY/rollout、企业 SSO、真实双设备恢复或大文件压力验收。LiteLLM v1.106.2 的 DMZ 升级交付独立于本包，需分别安排和验收；本包不改 LiteLLM、Nginx、TLS、博查或 ASR 路由。

用户反馈昨天 MinIO 运行在其它服务器，而非 nj304；当前尚未核验线上 Pod/PV。仓库旧模板已设置 nj304 节点约束，实际部署资源、卷亲和性和节点标签需分别核对。本次交付不迁移、重启或重建 MinIO，README 提供只读核对命令。

## 2026-10-22 内网到 DMZ 的 ASR WebSocket 代理方案

DMZ 主机、容器、挂载、网络及已确认路由见 [DMZ 服务器现场记录](docs/DMZ-SERVER.md)，后续操作前先读取并复核现场。

DMZ 现场已确认容器 `litellm-gateway`，host 网络，实际配置为 `/home/admnj00663/litellm/nginx.conf`（只读单文件 bind mount）。提供单文件脚本 `deploy/nj304-litellm-proxy/asr/deploy-dmz-asr.sh`：先 `sudo env CHECK_ONLY=1 bash deploy-dmz-asr.sh`，通过后 `sudo bash deploy-dmz-asr.sh`。自动继承博查来源白名单，备份、原位写入、校验、reload，失败尝试自动恢复；本地逻辑和 Bash 语法检查通过，未在生产执行。完整说明见下方文档。

部署命令、验收和回退见 [内网 DMZ 代理服务说明](docs/INTRANET-DMZ-PROXY.md)。后续涉及 30443、DMZ 出口和长连接转发需求时，先读该文档并核对线上配置。

新增路径 `/api-ws/v1/inference`：内网客户端 → `aigcplatform.boschhuayu-steering.com:30443` → `nj304-litellm-proxy` → DMZ `192.168.10.30:443` → 百炼工作空间 WebSocket。内网到 DMZ 按用户要求关闭上游证书校验，无需新增 DMZ CA 挂载；客户端入口证书校验、DMZ 到百炼的公共 CA 校验保留。两侧需显式配置 HTTP/1.1 Upgrade。

交付目录 `deploy/nj304-litellm-proxy/asr/` 包含两侧 location 和基于线上 ConfigMap 的增量补丁生成器。保留新旧 SNI server、现有 TLS Secret、聊天及博查规则；不要重新 apply 历史初装 proxy.yaml。无需重建镜像，不修改 API、Portal 或数据库。只整理本地交付，未部署生产；单副本代理重启会中断长连接，需安排窗口。实际识别、断开与重连仍需现场验收。

## 2026-10-21 MinIO 云端备份离线更新

配套 DSH Windows x64 未签名内部包已构建：`output/dsh-main-0.1.7-alpha.2.20261021.2`，含 EXE、blockmap、nightly.yml、校验清单及构建验证记录。包内正式后端为 `https://aigcplatform.boschhuayu-steering.com`；已确认包含分片备份/选择恢复、模型重连、插件更新提示和深色下拉框修复。13 项定向测试和最终包运行时冒烟通过（Workspace controller、原生工具、DOCX/XLSX/PPTX 转 PDF），blockmap 覆盖字节数与安装器一致。没有上传发布、安装到生产设备或完成真实双设备恢复验收。

完整交付包 `output/aigc-update-2026-10-21-minio.1.zip`，交付目录 `deploy/k8s/bosch-aigc-dsh/update-2026-10-21-minio.1`。API/Portal 镜像均为 `2026-10-21-minio.1`，新增 MinIO `aigc-backup-minio:2025-06-13-offline.1`，三个镜像统一导出 linux/amd64 TAR。包含更新、配置预检、验证、回退脚本与校验清单。构建使用 main 当前工作区快照，包含未提交改动，来源和散列见 BUILD-INFO.json。

目标是 namespace `bosch-aigc-dsh`、nj304/containerd；先在 nj304 导入三个镜像，再在控制节点执行 `CHECK_ONLY=1 ... bash update.sh`，通过后执行实际更新。脚本新增 K8s MinIO 的静态 Retain PV/PVC、内部 Service、私有桶初始化 Job 和 Secret，再启用 API 的 BackupStorage 配置。已有资源和凭据检查后复用；API 单副本，默认单次 1GiB、账号 10GiB、分片 8MiB。管理凭据按用户指定在部署时创建，应用账号独立生成，密钥不进入镜像。本地开发连接配置已从构建上下文剔除。无数据库结构迁移，默认不做 dump，可设置 BACKUP_DATABASE=1；回退恢复镜像与 API env，保留 MinIO 与所有数据卷。

本地后端 18 项（含真实 MinIO）、Portal 10 项、脚本 22 项通过；新镜像隔离验证健康/页面 HTTP 200，真实 MinIO 两片上传、续传状态、完整下载 SHA-256、Range、删除及最小权限应用账号通过。未执行生产集群预检或部署，未执行 1GiB 压测/真实双设备验收。本包不含 DSH 安装器，分片备份、选择恢复和本轮客户端修复需要兼容的新客户端。完整主机分工和命令见[本次部署说明](deploy/k8s/bosch-aigc-dsh/update-2026-10-21-minio.1/README.md)。

## 2026-10-15 新域名手动部署交付

交付目录 `deploy/k8s/bosch-aigc-dsh/domain-switch-2026-10-15`。API/Portal 已构建为 `2026-10-15-domain.1`，linux/amd64；离线包 `artifacts/aigc-domain-images-linux-amd64.tar`，SHA-256 `690b68f6910a6b5004059ca9c9efa0a4acfa94e585a5f4db550d25d94e77531c`。Portal 编译期 API 地址为 `https://aigcplatform.boschhuayu-steering.com`，镜像内容已检查不含旧 API 地址。镜像包含当前源码的云端备份功能和下载页；并非只修改旧镜像配置。

用户最新要求恢复此前 update.sh 方式。本次提供 update.sh、prepare.py、verify.sh 和 rollback.sh，基于线上快照生成定点补丁。完整的主机分工、镜像传输导入、检查、更新、验证和回退命令见[本次部署文档](deploy/k8s/bosch-aigc-dsh/domain-switch-2026-10-15/README.md)。新 Portal、API 和 SSO 统一使用新域名；旧域名保留客户端 `/api`、`/v1` 和历史更新文件兼容，旧网页入口跳转到新域名。新证书仅覆盖 aigcplatform；脚本创建独立 aigc-platform-tls，保留旧 aigc-edge-tls，并为 edge 和模型代理增加 SNI server 与新证书挂载，兼容旧客户端。提供的 CRT/KEY 已验证配对，并从匹配 PFX 提取企业 CA 链。仍需企业 CAS 新回调许可。此处仅记录本地构建交付，尚未生产部署或完成企业 SSO 验收；旧条目中的域名是历史记录，后续更新不得将配置改回旧值。

## 2026-10-14.3 下载页离线更新

交付目录 `deploy/k8s/bosch-aigc-dsh/update-2026-10-14.3`，API/Portal 镜像均为 `2026-10-14.3`、linux/amd64。包含下载页 `/desktop`、首页入口和受授权的首次安装下载接口，保留此前 SSO 退出与日志留档功能。本包不含 DSH 安装器，不自动上传或发布客户端版本。完整导入、部署、验收与回滚命令见交付 README；本地构建不代表生产部署完成。

## 弯崽工作伙伴首次安装下载页

Portal 新增 `/desktop`，AIGC 主页导航“客户端下载”可进入。页面使用现有弯崽 Logo，目前只提供 Windows x64。未登录时点击下载会通过 `/login?returnTo=%2Fdesktop` 完成中台登录，再返回下载页。

首次安装接口：`GET /api/desktop-downloads/windows-x64` 取得账号可下载的最高语义版本，`POST /api/desktop-downloads/{id}/ticket` 签发 10 分钟 HttpOnly 下载 Cookie，`GET /api/desktop-downloads/{id}/installer` 以附件及 Range 响应提供安装器。JWT 不进入文件 URL，也不要求先上报或登记 DSH 设备。下载时再次检查账号启用状态、发布状态和接收范围。

安装包复用客户端灰度发布管理和 `DesktopReleases__Root` 持久目录；管理员上传安装器、选择人员/部门/角色并发布后，对应用户才能下载。接收范围沿用已有发布管理在保存时生成的用户快照；新建账号尚未在该快照中时，需管理员更新接收范围。草稿、已暂停、无权限或安装包丢失时不给出下载。没有可用版本时页面显示明确空态，不能把本地构建的 EXE 自动视为已发布版本。

部署本功能需同时重新构建 API 与 Portal；现有入口 `/api` 代理及 Data Protection 持久化配置可复用。本功能在 `2026-10-14.2` 离线包之后开发，之前交付的 ZIP 不包含下载页，本次源码开发未执行生产部署或上传发布安装包。

## 2026-10-14.2 最新 API/Portal 构建

交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-10-14.2`，镜像为 `aigc-api:2026-10-14.2`、`aigc-portal:2026-10-14.2`，目标平台 linux/amd64。包含 Bosch SSO 主动退出后停止自动登录的修复，以及此前用户日志持久化和滚动限制。完整导入、更新、验证与回滚命令见该目录 README。DSH 客户端由用户自行打包，不包含于本次离线更新。未执行生产部署。

## 2026-10-14.1 日志与 SSO 离线更新

本次交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-10-14.1`；完整命令见该目录 `README.md`。API/Portal 镜像均为 `2026-10-14.1`、linux/amd64，包含中台 Bosch SSO 和服务器用户日志。本地打包及隔离验证不代表生产部署完成，真实 CAS 回跳需要企业网络验收。

API 日志同时输出 JSON 控制台和滚动 JSONL 文件。Portal JWT 与 DSH 访问令牌请求关联用户 ID、工号、姓名及 `TraceId`；异常响应/响应头提供同一追踪 ID，异常日志记录堆栈。成功健康探针不记录普通请求日志。密码、令牌、SSO ticket、请求体和查询字符串不作请求日志采集。

新增独立日志 PV `bosch-aigc-dsh-logs` / PVC `aigc-logs`，固定 nj304 主机目录 `/var/lib/aigc-hub/logs`，挂载到 API `/var/log/aigc-hub`，回收策略 `Retain`。集群无 StorageClass，更新脚本先在 nj304 创建目录并申请独立 2Gi 静态卷，不重建数据库/密钥/上传卷。新部署也须先应用 `logging-storage.yaml`。日志按 UTC 日期和大小滚动，默认单文件 20 MiB、最多 50 文件、保留 14 天，先达到的限制先清理。local PV 容量声明不是磁盘硬配额，实际应用正文文件总量上限约 1000 MiB。

配置项：`FileLogging__Enabled=true`、`FileLogging__Directory=/var/log/aigc-hub`、`FileLogging__MaxFileSizeBytes=20971520`、`FileLogging__MaxFiles=50`、`FileLogging__RetentionDays=14`。启动时检查目录可写；运行中归档故障输出控制台告警并每 30 秒重试。控制节点可用 `kubectl -n bosch-aigc-dsh logs deployment/aigc-api --since=10m` 查询实时日志；nj304 可用 `sudo grep -F '工号或TraceId' /var/lib/aigc-hub/logs/aigc-*.jsonl` 查询留档。日志滚动保留，不作永久审计归档。

更新脚本保留实际变更前配置、镜像和数据库备份，回滚恢复镜像、API 环境变量及卷挂载，保留日志和业务数据。不要用旧数据库备份直接覆盖更新后的新数据。本节之后的记录属于历史上下文，当前交付命令以本次 README 为准。

更新日期：2026-10-09。本文依据已有聊天资料整理。本文中的 Kubernetes 信息来自用户提供的输出，不代表已经重新检查当前集群。后续部署前，先读取本文，再检查实际文件、镜像、资源名称和运行状态。Portal 指 AIGC Portal，用户此前写作 protal。

## 本地项目与文件

- 工作区：`D:\Code\Bosch\aigc`。
- DSH 仓库：`D:\Code\Bosch\aigc\deepseek-harness`。
- Kubernetes 部署目录：`D:\Code\Bosch\aigc\deploy\k8s\bosch-aigc-dsh`。
- AIGC 域名证书目录：`D:\Code\Bosch\aigc\deploy\k8s\bosch-aigc-dsh\ssl`。
- 本记录未核验这些目录当前的文件清单。生成命令前读取其中的部署脚本、Dockerfile 和 YAML，不猜测文件名或镜像标签。

## 集群与网络

| 项目 | 已知值 |
|---|---|
| Kubernetes | v1.28.2 |
| 容器运行时 | containerd 1.7.28 |
| 控制节点 | bosch-k8s-nj-master，172.28.2.26 |
| 目标工作节点 | bosch-k8s-node-nj304，172.28.2.33 |
| 目标节点标签 | kubernetes.io/hostname=bosch-k8s-node-nj304；bosch-aigc-server=true |
| 命名空间 | bosch-aigc-dsh |
| AIGC 公网入口域名 | aigcbackend.boschhuayu-steering.com，解析到 172.28.2.33 |
| LiteLLM 域名 | litellm.boschhuayu-steering.com，192.168.10.30 |

DSH 不能直接访问 LiteLLM。目标链路为：DSH → nj304 上的 Nginx 反向代理 → LiteLLM 服务器上的 Nginx → LiteLLM 的 4000 端口。

DSH 登录和业务控制仍通过 AIGC。AIGC 负责签发用户 Virtual Key、提供客户端模型访问地址；管理密钥保留在服务端。

## 已知 Kubernetes 资源

| 资源 | 名称 | 服务端口或用途 |
|---|---|---|
| Service | aigc-api | ClusterIP，8080/TCP |
| Service | aigc-portal | ClusterIP，3000/TCP |
| Service | aigc-postgres | ClusterIP，5432/TCP |
| Deployment | nj304-litellm-proxy | Nginx 代理，已有启动日志证明曾运行 |
| Service | nj304-litellm-proxy | NodePort，443:30443/TCP |
| ConfigMap | aigc-settings | AIGC 环境配置 |
| TLS Secret | aigc-edge-tls | 用户提供过该 Secret 的查询结果；复用前确认类型和 tls.crt、tls.key 键 |

不要依赖 Service 的 ClusterIP，它可能随资源重建变化。AIGC 与 Portal 的 Deployment 名称、镜像标签、卷和入口 Nginx 资源未在本记录中确认。

## AIGC 部署与配置

AIGC 运行在 Kubernetes 中，以 `aigc-api` Service 暴露 8080 端口，环境配置存于 `aigc-settings`。实际 Deployment 是否使用 envFrom、是否存在同名显式 env 覆盖，部署前检查 YAML。

用户最后提供的配置包含：

```text
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://+:8080
Cas__Enabled=true
Cas__PublicBaseUrl=https://aigcbackend.boschhuayu-steering.com
Cas__PortalBaseUrl=https://aigcbackend.boschhuayu-steering.com
Cas__ServiceUrl=https://aigcbackend.boschhuayu-steering.com/v1/auth/cas/callback
Cas__VerifySsl=false
Cors__Origins__0=https://aigcbackend.boschhuayu-steering.com
DataProtection__KeysPath=/var/lib/aigc-hub/data-protection
DshUploads__Root=/var/lib/aigc-hub/dsh-uploads
LiteLlm__BaseUrl=https://litellm.boschhuayu-steering.com/v1
LiteLlm__PublicBaseUrl=https://litellm.boschhuayu-steering.com/v1
LiteLlm__TimeoutSeconds=20
LiteLlm__VerifySsl=false
```

### AIGC 中台 Bosch SSO

主动退出中台后返回 `/login?sso=logged-out`，当前浏览器标签页记录主动退出状态。该状态下登录页不自动发起 SSO，用户需点击登录按钮；成功保存新会话后清除该状态。此操作退出中台本地会话，不注销其他企业应用共用的 Bosch CAS 会话。此修复在 2026-10-14.1 离线包生成之后完成，旧包不包含它，需重新制作 Portal 镜像后发布。

`/login` 默认自动跳转 Bosch SSO，`/login/local` 保留工号密码登录页。SSO 成功后返回原目标页面；回跳失败或过期时显示重试及本地登录入口，不重复自动跳转。Portal 使用 `/api/auth/sso/config`、`/api/auth/sso/start`、`/api/auth/sso/complete`，CAS 仍回到现有 `/v1/auth/cas/callback` 路径。Portal 回跳的 `service` 增加随机 `portal_state` 查询参数，票据验证使用完全相同的完整 URL；Bosch CAS 的服务注册规则必须允许该回调路径及此查询参数。DSH 登录继续使用不带该参数的原 `service`。

`Cas__PortalBaseUrl` 设置为用户访问中台的地址，不是容器内部地址；未配置时沿用 `Cas__PublicBaseUrl`。生产清单中两者均为 `https://aigcbackend.boschhuayu-steering.com`。本地调试可将 Portal 地址设为 `http://localhost:3000`，API 地址设为 `http://localhost:5080`。Portal 与 API 应保持同站点，跨端口或跨子域部署还需将 Portal 的完整来源加入 `Cors__Origins`；不要混用 HTTP 与 HTTPS。

登录凭据通过短期 HttpOnly Cookie 兑换中台现有 JWT，JWT 不写入回跳 URL。Data Protection 密钥必须持久化；多副本应共享该密钥目录。已有账号保留原角色、授权和密码；首次 SSO 登录仅分配既有普通用户角色与匹配部门，不生成共享初始密码。需要本地密码时由管理员显式设置。

验收顺序：先检查 `/api/auth/sso/config` 返回 `enabled: true`，再从登录页进入 Bosch SSO，确认回到中台原目标页，随后验证 `/api/auth/me` 和授权页面。停用账号、过期回跳及票据验证失败应回到可重试的登录页。更新源码和清单不代表线上已生效；需同时发布 API 与 Portal，并应用新增配置。本次不自动打包或部署。

其中 `LiteLlm__BaseUrl` 是 AIGC 服务端访问 LiteLLM 的地址；`LiteLlm__PublicBaseUrl` 是发给 DSH 的访问地址。代理切换的目标配置是：

```text
LiteLlm__BaseUrl=https://litellm.boschhuayu-steering.com/v1
LiteLlm__PublicBaseUrl=https://aigcbackend.boschhuayu-steering.com:30443/v1
```

该 PublicBaseUrl 是否已经应用到当前集群，尚未确认。修改 ConfigMap 后，对实际读取它的 AIGC Deployment 执行 rollout restart，并等待 rollout status；不能仅修改 ConfigMap 就认为进程配置已经更新。

部署步骤：读取实际构建与部署文件 → 构建版本化镜像 → 离线导出并传到目标节点 → 导入 containerd → 更新实际 Deployment 的镜像和配置 → 等待 rollout → 验证登录、Virtual Key 和客户端收到的 PublicBaseUrl。保留数据保护密钥、上传数据和数据库卷。

## Portal 部署

Portal 已知运行在同一命名空间，以 `aigc-portal` ClusterIP Service 暴露 3000 端口。外部入口、API 转发路径、前端构建变量、Deployment 名称和镜像构建命令需要读取现有文件确认。

部署步骤：确认 Portal 的 Dockerfile、构建脚本和 API 地址注入方式 → 构建版本化镜像 → 导出和导入目标节点 → 更新实际 Deployment 镜像 → 等待 rollout → 验证页面、登录及 API 请求。前端构建时变量变更可能需要重新构建，不能假设重启 Pod 即生效。

## DSH 桌面端部署

DSH 是桌面客户端，不是本记录中的 Kubernetes Service。修改后需要重新打包并安装或通过已有 AIGC 更新通道发布。用户提供过完整版本示例：`0.1.7-alpha.2.20261008.2`；发布时使用本次实际打包版本。

聊天中已知的 Windows 未签名打包入口，必须先核对当前 package.json：

```powershell
Set-Location D:\Code\Bosch\aigc\deepseek-harness
pnpm run package:desktop:win:x64:unsigned -- --build-version auto
```

已知对应产物目录为 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`。实际脚本、环境文件、依赖准备和版本规则以当前仓库为准。

Windows 内部程序名固定为 `bhssAiWork.exe`，安装包采用 `bhssAiWork-<版本>-win-x64[-unsigned].exe`；界面品牌与快捷方式名称单独配置，更换品牌时保持应用 ID、包名、更新缓存身份与用户数据路径不变。升级沿用已登记的原安装目录，并兼容目录内的 `BHSS办公助手.exe`、`弯崽工作伙伴.exe` 和 `deepseek-harness.exe`。命名与兼容行为以 DSH 的 `apps/desktop/README.zh.md` 为准。

内部更新使用 AIGC 提供的版本和安装包。未签名安装包与已有签名客户端的发布者校验存在差异，不能假设可以直接自动切换；先确认客户端安装基线与发布方式。

本地失败日志已实现默认保留 7 天、自动清理、脱敏及手动导出。DSH 异步上传、AIGC 接收存储及管理界面在主聊天中已获授权开发，但本记录尚无完成或部署验证证据。后续需要检查主任务实际交付，再补充接口、迁移和配置，不能据此认为功能已经上线。

## nj304 LiteLLM 反向代理

代理资源为 `nj304-litellm-proxy`，客户端地址为 `https://aigcbackend.boschhuayu-steering.com:30443/v1`。Pod 应通过 hostname nodeSelector 固定到 nj304，实际 YAML 部署前核验。

代理向 `https://litellm.boschhuayu-steering.com` 转发，保留 `/v1/...` URI，并设置正确的上游 Host 与 TLS SNI。为流式输出关闭 proxy_buffering，使用适合长请求的超时。用户无法提供 LiteLLM CA，曾授权绕过上游证书验证；实际 `proxy_ssl_verify` 状态应读取配置确认。客户端验证代理入口证书是另一段 TLS，不能靠上游关闭校验解决。

入口证书优先复用 `aigc-edge-tls`，检查证书域名和有效期。`kube-root-ca.crt` 是 Kubernetes API CA，不能用来替代 AIGC 或 LiteLLM 的业务证书 CA。

已知曾运行 Nginx 1.30.4 Alpine。实际镜像完整名称、标签、摘要和架构需要查询，不能只凭 nginx 版本推导镜像标签。

LiteLLM 服务器现有 Nginx 监听 443，域名为 `litellm.boschhuayu-steering.com`，使用 `/etc/nginx/tls/fullchain.pem` 和 `/etc/nginx/tls/private.key`；普通请求代理到 `http://127.0.0.1:4000`，使用 Docker host networking。另有精确路径 `/__aigc/deepseek-search` 转发 DeepSeek API，仅允许 172.28.2.33 且仅接受 POST。该独立路径不得被普通模型代理改动覆盖。

## 部署前查询命令（Bash，在 Kubernetes 控制节点执行）

```bash
kubectl get node bosch-k8s-node-nj304 -o wide
kubectl -n bosch-aigc-dsh get deploy,pod,svc -o wide
kubectl -n bosch-aigc-dsh get cm aigc-settings -o yaml
kubectl -n bosch-aigc-dsh describe secret aigc-edge-tls
kubectl -n bosch-aigc-dsh get deploy -o yaml
kubectl -n bosch-aigc-dsh get svc nj304-litellm-proxy -o yaml
kubectl -n bosch-aigc-dsh logs deploy/nj304-litellm-proxy --tail=50
```

不要输出 Secret 的 base64 数据或真实 Virtual Key 到聊天记录。

镜像查询在 nj304 执行：

```bash
sudo ctr -n k8s.io images list
sudo crictl images
```

离线导入示例，在确认 tar 已传到 nj304 后执行：

```bash
sudo ctr -n k8s.io images import nginx-image.tar
```

曾遇到 `content digest ... not found`，之后用户反馈加载成功。再次发生时检查导出包完整性和平台内容，不假设重试同一损坏包会解决。镜像名称必须与 Deployment 引用一致，并检查 imagePullPolicy，避免离线部署仍尝试拉取。

## 验证与重启

已确认的代理 Deployment 可用以下命令：

```bash
kubectl -n bosch-aigc-dsh rollout restart deployment/nj304-litellm-proxy
kubectl -n bosch-aigc-dsh rollout status deployment/nj304-litellm-proxy --timeout=180s
curl -k https://aigcbackend.boschhuayu-steering.com:30443/healthz
```

`curl -k` 仅为本次排查入口证书信任问题的测试方式；正式客户端需确认信任企业 CA。曾出现 curl 的 `unable to get local issuer certificate`，不能把 Nginx 已启动视为客户端证书校验已解决。

AIGC 和 Portal 先查询实际 Deployment 名称，再生成准确的 restart、set image 和 rollout status 命令。不要把 Service 名称直接当成已确认的 Deployment 名称。

模型验证使用当前用户有效 Virtual Key，先查 `/v1/models` 取得授权模型，再请求 `/v1/chat/completions`。测试请求与代理 access log 的时间、路径、状态关联，可证明该请求经过代理。HTTP 200 还需检查流是否完整及客户端是否收到结果。

## 后续生成部署命令的规则

1. 先读本文件，再读当前部署目录、Dockerfile、package.json 和主任务新增的部署说明。
2. 查询实际 Deployment、容器名、镜像标签、节点镜像和配置，补齐本文未确认项。
3. 明确命令运行位置：Windows PowerShell、本地 Docker、控制节点 Bash、nj304 Bash。
4. 分别提供镜像构建、导出、传输、导入、资源应用、重启、验证和回滚命令。
5. 记录变更前镜像与配置，遵守现有数据库迁移和持久化策略；不重建或删除数据卷。
6. 将代码完成、打包完成、集群部署完成和业务验证完成分别表述，不把历史计划作为当前状态。
