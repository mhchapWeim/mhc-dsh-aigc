# DSH、AIGC 和 Portal 部署记录

## 2026-11-24 访问审核负责人 API/Portal 离线包（未部署）

基于 `codex/dsh-upstream-integration` @ `972285a7` 的当前工作区，包含未提交的访问审核负责人和后台焦点样式。只构建 API 与 Portal，不构建 DSH 客户端，也不重建应用网关。没有执行生产导入、CHECK_ONLY、数据库备份或 Deployment 更新。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-24-access-review-app-only`
- ZIP：`output/aigc-update-2026-11-24-access-review-app-only.zip`，163,839,778 字节
- ZIP SHA-256：`b6af25a9caa20ebebb292c17febb4c9b25814b7054016b1221abf029eda5ac4d`
- 镜像：`aigc-api:2026-11-24-access-review`（`sha256:ea544dd823e92d2b2834130136466deb84131b53571a44de45f4276d118c05c1`）、`aigc-portal:2026-11-24-access-review`（`sha256:33e0fcdace176ca65063a140396f565d2e19d2395f9e157bf30ac40cbd37bc51`），linux/amd64
- tar SHA-256：`53b2fa8a5d765bf153d8344476be655b96220f296d5c6a13b197d9e8b9f505f0`，164,788,736 字节

API 启动幂等增加 `PublicationRequests.AccessReviewerId` 与 `RegisteredApplications.AccessReviewerId`。`update.sh` 因此默认强制数据库 dump。补丁只替换两个容器镜像和 `imagePullPolicy=Never`，不改 Secret、ConfigMap 或 PVC。预检脚本 20 项通过。API 镜像 6 个开发凭据字段已脱敏，Portal 旧域名 0 处。命令见该目录 README。获得授权后先导入 nj304，再 `CHECK_ONLY=1`，确认回滚镜像后才运行 `update.sh`。

## 2026-11-20 应用网关根路径修复镜像（未部署）

只重建网关镜像，修复带会话访问 `/{slug}` 和 `/{slug}/` 时仍提示「请从 AIGC 应用集合进入此应用」。API、Portal、`aigc-edge` 和 `aigc-settings` 不需要变更。本地 `ApplicationGatewayHttpTests` 4 项通过。镜像内 `AigcHub.Api.dll` 含 `ForwardAsync`。

- tar：`output/aigc-gateway-2026-11-20-gateway-root-linux-amd64.tar`，100,489,728 字节
- tar SHA-256：`234d04a1980369a192a664fd6a3c7959f2773f32be86fbf9507d16130a5974d5`
- 镜像：`docker.io/library/aigc-gateway:2026-11-20-gateway-root`（`sha256:8f67ab785f88b9b4387e77fe8f6456d94044510dd9c67b22596714e55de17bee`），linux/amd64

在 nj304 导入后，于控制节点只改网关 Deployment 的镜像并等待滚动完成。不要重建 `aigc-edge`。

## 2026-11-19 应用网关 API/Portal/Gateway 离线包（未部署）

基于 `codex/dsh-upstream-integration` 当前工作区，包含申请管理、流程绑定、访问授权和应用网关。只构建 API、Portal 和新网关，不构建 DSH 客户端。没有执行生产导入、CHECK_ONLY、数据库备份或 `aigc-edge` 变更。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-19-app-gateway-app-only`
- ZIP：`output/aigc-update-2026-11-19-app-gateway-app-only.zip`，169,720,990 字节
- ZIP SHA-256：`cf5cd8df17599d6de5e3135d0bcda7c3fcda32be144830e623d499377150b47f`
- 镜像：`aigc-api:2026-11-19-app-gateway`（`sha256:3e5576523e06fbdd9c734680b0d331847671b4acc2765e9559a2eee763f1a237`）、`aigc-portal:2026-11-19-app-gateway`（`sha256:158b4623aa757d443a477b9ffa617202dea589edb10a45708c3fb7b1f5e63411`）、`aigc-gateway:2026-11-19-app-gateway`（`sha256:30bd323f8b66054a31020020f088650d630fba9fdd3e9d942139842ea19c4895`），linux/amd64
- tar SHA-256：`5d0e3410b645f13abbed8ef7b228ad4448e068c84f0c678e78248fedb385a7b1`，170,598,400 字节

新增 Kubernetes Service `aigc-app-gateway`，端口 8080，选择器 `app=aigc-app-gateway`。对应 Deployment 同名，单副本，固定到 `bosch-k8s-node-nj304`，镜像拉取策略 `Never`。它复用现有 `aigc-settings` 和 `aigc-secrets`，不使用主机网络，因此不占用 80/443。`update.sh` 在授权更新时创建该 Deployment 和 Service，并只向 `aigc-settings` 追加 `ApplicationGateway__*`。部署服务连接另按交付目录 `DEPLOYMENT-CONNECTION.md` 把 `IntegrationConnections__Deployment__*` 的非敏感项合并进同一个 ConfigMap；密码和 `CallbackSecret` 留在 `aigc-secrets`。服务标识 `deployment` 由管理页面写入数据库，不进 ConfigMap。真实更新前要设置 `GATEWAY_ALLOWED_UPSTREAM_HOSTS`。`aigc-edge` 仍是中台入口。`/{slug}` 要等网关健康后，用交付目录里的 `aigc-edge-nginx.configmap.yaml` 执行 `kubectl apply -f`，再重建 `aigc-edge`。步骤见同目录 `EDGE-NGINX.md`。本包的更新脚本不会改它。这份 ConfigMap 文件在已打好的 ZIP 之外，需要单独拷到控制节点。

预检脚本 20 项通过。API 镜像 6 个开发凭据字段已脱敏。公开域名使用 `https://aigcplatform.boschhuayu-steering.com`。命令见该目录 README。获得授权后先导入 nj304，再 `CHECK_ONLY=1`，确认回滚镜像后才运行 `update.sh`。

## 2026-11-18 托管插件灰度 app-only 离线包（未部署）

基于 `codex/dsh-upstream-integration` @ `972285a7` 的当前工作区，包含未提交的 `PilotReleasesJson` 与门户「灰度发布」。只构建 API 与 Portal，不改 Secret、ConfigMap、PVC 或插件存储。生产镜像更新、插件发布和客户端灰度尚未授权。本机没有 Kubernetes context，因此没有查询现场镜像，没有执行 `CHECK_ONLY`，也没有备份 PostgreSQL。回滚镜像要等控制节点预检快照里的 `images.json`。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-18-plugin-pilot-app-only`
- ZIP：`output/aigc-update-2026-11-18-plugin-pilot-app-only.zip`，163,555,947 字节
- ZIP SHA-256：`15f31161e70e848a1a095d5949c06e3303162b9f4ca72b98a09acb296ee6ed7b`
- 镜像：`aigc-api:2026-11-18-plugin-pilot`（`sha256:93797fb43f7779637bdf478f7537bf19b24ef80c150cf8dbc681bfce8ef2a754`）、`aigc-portal:2026-11-18-plugin-pilot`（`sha256:b2e64f9286f5f40fd87cc7ce4ca259765883f8d8b718ea22210d507a95d3740d`），linux/amd64
- tar SHA-256：`88bf6c503ab3ef072f3e4eb2efc960f12825f97ae8cf373ce24af6a439fa01b6`，164,493,312 字节

预检脚本 20 项通过。API 镜像含增量列符号，6 个开发凭据字段已脱敏。命令见该目录 README。获得授权后先导入 nj304，再 `CHECK_ONLY=1`，确认回滚镜像后才运行 `update.sh`。三位灰度用户工号尚未确认。

## 2026-11-13-main.2 Gitea 证书校验开关 API 修复包（未部署）

现场授权回调 `/api/code-sources/gitea/complete` 因公司CA证书链 `PartialChain` 失败。用户授权临时绕过Gitea证书校验；新增按连接引用读取 `VerifySsl`，缺省 true，显式false才使用独立Gitea客户端跳过校验。覆盖授权交换、刷新及仓库API，其他HTTPS服务不变，禁止自动重定向。

- 交付包：`output/aigc-update-2026-11-13-main.2-gitea-tls-api-only.zip`，99,499,847字节。
- ZIP SHA256：`2c458b16d1bb2b923ff9283f3bdef2a4bdc71f98db733424116884d29d20af8e`。
- 镜像：`aigc-api:2026-11-13-main.2-gitea-tls`，linux/amd64；无Portal重建、无DSH。
- 目录及步骤：[API-only README](deploy/k8s/bosch-aigc-dsh/update-2026-11-13-main.2-gitea-tls-api-only/README.md)。先nj304导入tar，再控制节点运行 `bash enable-gitea-tls-bypass.sh`。
- 脚本设置现有 `aigc-settings` 中 `IntegrationConnections__GiteaBosch__VerifySsl=false`，清除Secret同名遮蔽键，备份并只更新/重启API，保留OAuth凭据及其他配置。
- 后端全量249通过/4跳过；追加真实自签名HTTPS测试后Gitea专项8通过，验证默认严格/显式绕过/严格客户端隔离/拒绝重定向。新API镜像PostgreSQL+MQ七种终态/去重冒烟通过。tar层哈希、docker load、ZIP完整性通过。

本包未在生产执行。部署后重新发起Gitea授权；后续安装公司CA后按README恢复VerifySsl=true。

## 2026-11-13 新审查协议 API/Portal 离线交付（未部署）

本次交付优先于下面 11-12 的旧协议材料。基于 main 当前工作区脱敏快照，包含审查方 `code-review-20261112` snake_case 协议、严格 AMQP/字段校验、七种终态、幂等回传与人工复核；包含既有 Gitea 用户授权与固定提交选择。不包含 DSH 客户端或基础设施镜像。

- ZIP：`output/aigc-update-2026-11-13-main.1-review-mq-app-only.zip`，191,492,956 字节。
- ZIP SHA-256：`934bd5a27fc65838528e25335ef7512f749756c46edb7a8b43b13ba2ce93159a`。
- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-13-main.1-review-mq-app-only`。
- 镜像：`aigc-api:2026-11-13-main.1-review-mq`、`aigc-portal:2026-11-13-main.1-review-mq`，均 linux/amd64。
- 镜像 tar：`aigc-images-2026-11-13-main.1-review-mq-linux-amd64.tar`；SHA-256：`69882fa0d383a518de4857c638d826733847e585eb7b66f63d3139c5f9242a36`。
- Portal 编译期 API 地址：`https://aigcplatform.boschhuayu-steering.com`；build-images.ps1 / package-offline-images.ps1 的旧域名已修正。

生产 MQ 使用用户现场确认的既有 `bosch-aigc-dsh/aigc-mq`：nj304=`172.28.2.33`，AMQP NodePort30672、管理 NodePort30242，vhost=`/aigc`。旧 YAML 与 last-applied 中的 ClusterIP 已过期，不要 apply 旧 RabbitMQ 部署文件。API 内部连接 `aigc-mq:5672`。

在控制节点、完整解压目录内，按 [MQ 增量命令](deploy/k8s/bosch-aigc-dsh/update-2026-11-13-main.1-review-mq-app-only/MQ-DEPLOYMENT.md) 预检后运行：

```bash
sha256sum -c SHA256SUMS
python3 mq/configure-workflow.py > workflow-plan.json
python3 mq/configure-workflow.py --apply --patch-api --patch-configmap
```

完整创建MQ、修改Secret和ConfigMap的命令统一见 [ALL-DEPLOYMENT-COMMANDS.md](deploy/k8s/bosch-aigc-dsh/update-2026-11-13-main.1-review-mq-app-only/ALL-DEPLOYMENT-COMMANDS.md)。联合模式将非敏感参数写入现有 `aigc-settings`、密码写入 `aigc-secrets`，清除Secret中对应同名非敏感键，保留其他现场配置。

脚本交互读取管理员和新业务账号密码，增量创建交换机/队列/权限/策略，合并现有 `aigc-mq-definitions` 与 `aigc-secrets`；不修改 Service、NodePort、RabbitMQ Deployment 或存储，不重启服务。审查请求路由 `code-audit.submit.v1`，结果交换机独立并绑定 `review.finished`、`review.rejected` 及旧事件 `audit.completed.v1`。生产账户与密钥不在交付包中。

应用导入、强制数据库备份、CHECK_ONLY、只更新两个镜像及回退步骤见 [README](deploy/k8s/bosch-aigc-dsh/update-2026-11-13-main.1-review-mq-app-only/README.md)。新协议服务登记和流程版本需由管理页面配置，不自动修改既有实例。

本地验证：后端246通过/4跳过，前端52文件246通过，MQ拓扑6项、部署预检20项通过；新镜像连接隔离真实 PostgreSQL/RabbitMQ，七种审查结果及重复回传通过，三项新增列、四个鉴权入口、Portal七页通过。镜像敏感配置脱敏、旧域名检查、三份shell语法、tar全部layer校验及docker load、ZIP CRC/逐文件SHA均通过。详见交付目录 `BUILD-INFO.json`、`VALIDATION.md`。

**本次仅生成命令与离线包，未执行生产导入、MQ配置、Secret修改或应用部署；真实审查服务及生产Gitea联调仍待现场验收。**

## 2026-11-12 代码审计 MQ 集成 API/Portal 构建

已基于 `main` 当前工作区构建 `2026-11-12-main.1-audit-mq` 离线包，交付代码审计第三方服务（MQ 异步）对接。包含：通用第三方异步流程节点（`executionMode=integrated-v1` 时 `serviceTask` 创建 `IntegrationInvocation`、投递 MQ、等待回调）、结果幂等与 Commit 校验、Gitea PKCE OAuth 用户授权与仓库/分支/固定提交选择、审计结果在审核详情页可见（结论徽标 + 详情页链接）、审计服务模拟器工具与第三方对接文档。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-12-main.1-audit-mq`
- 离线包：`output/aigc-audit-mq-images-linux-amd64.tar`（184 MB）
- ZIP SHA-256：`8a20d4453ee66936e59922a14a66acfed5f48426dc0dcb3a65fbb3ae554f7e6f`
- 镜像：`aigc-api:2026-11-12-main.1-audit-mq`（ID `850d59d37785`，351MB）、`aigc-portal:2026-11-12-main.1-audit-mq`（ID `3e6962729492`，398MB），linux/amd64
- **Portal 编译期 API 地址为 `https://aigcplatform.boschhuayu-steering.com`**，镜像内旧域名 `aigcbackend` 出现 0 次

**域名注意**：仓库 `build-images.ps1` 内 `$publicApiUrl` 仍写死旧域名 `aigcbackend`。本次按 2026-10-15 域名切换记录（"后续更新不得将配置改回旧值"）手工用新域名构建，该脚本需另行修正，否则下次构建会产出错误地址的 Portal。

MQ 拓扑本次新增（代码不含 `QueueDeclare`/`ExchangeDeclare`，必须预置）：交换机 `aigc.workflow.commands`（direct）、`aigc.workflow.dead-letter`（fanout）；队列 `aigc.workflow.code-audit.requests`、`aigc.workflow.code-audit.results`、`aigc.workflow.dead-letters`（均 quorum，死信队列带 7 天 TTL 与 10 万条上限）；绑定 key `code-audit.submit.v1`。创建方式见交付目录 `prepare-workflow-mq.py`（输出 hashes-only 的 definitions.json，可合并进既有 `aigc-mq-definitions`）与 README 方式 B（管理台临时创建）。

本次新增配置全部注入**既有 `aigc-secrets`**（merge patch，不新建 Secret）：`IntegrationConnections__CodeAudit__*`（含 `Password`、`CallbackSecret`，必须 Secret）与 `IntegrationConnections__GiteaLocal__*`（含 `ClientSecret`）。`AllowInsecureHttp` 生产不配置。第三方服务登记与流程定义属运行时数据（管理页面维护），不进 ConfigMap。

本地验证：API 镜像以真实 PostgreSQL 启动，`FormatException` 出现 0 次、正常监听 5080（schema 初始化 SQL 花括号会导致启动失败，已修复 `ExecuteSqlRawAsync` 需转义 `{}`）；Portal 四页 200、镜像内旧域名 0 处；`prepare-workflow-mq.py` 密码校验与 topology 输出通过。本次仅完成本地构建与离线交付，**尚未执行生产导入、MQ 拓扑创建、Secret 注入或第三方业务联调**。完整导入、拓扑创建、配置注入、验收与回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-12-main.1-audit-mq/README.md)为准。

## 2026-11-04-main.2 应用集合真实最近使用与卡片累计点击 API/Portal 构建

已基于 `main` 当前工作区构建 `2026-11-04-main.2-app-only` 离线包，包含门户应用集合「最近使用」接入真实数据、应用卡片改为累计点击、注册中心可单独调整累计点击。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-04-main.2-app-only`
- 离线包：`output/aigc-update-2026-11-04-main.2-app-only.zip`（191,310,236 字节）
- ZIP SHA-256：`52d41327bc185549a86867e25328845c2794d9c3e498ab12c7955edf1bbe0e82`
- 镜像：`aigc-api:2026-11-04-main.2`（ID `sha256:d68a542c975d...`）、`aigc-portal:2026-11-04-main.2`（ID `sha256:34d69ccd4349...`），linux/amd64，tar 192,525,824 字节

功能要点：新增 `GET /api/catalog/recent-apps?limit=`，按当前用户查询真实点击历史；此前该区域是两个硬编码假按钮。可见性复用 `ApplicationRegistryEndpoints.CanAccess`，撤权即消失；无记录不渲染、失败不阻塞目录。卡片由日/周/月/年四段改为单个「累计点击」（底部靠右放大），**点击报表保持四窗口不变**。注册中心新增「累计点击」输入，通过独立的 `Period="total"` 调整行与四个周期解耦，改周期不再影响累计值。同期包含 11-04-main.1 的自定义模型授权及更早全部内容。

修通过程中发现并修复两个真实缺陷：一是最近使用最初只判 `IsEnabled` 未判授权，撤权后仍留在列表（已用同一 `CanAccess` 修正）；二是注册中心最初把累计值发到顶层 `totalClicks`，而后端只读 `clicks.total`，导致保存后卡片数字不变（已改为 `clicks.total`，并补原始 JSON 端到端测试锁定契约）。

本包只更新两个镜像及 imagePullPolicy；不更新 DSH、MinIO、PostgreSQL、RabbitMQ、ConfigMap、Secret、PV/PVC。**数据库 dump 默认强制（BACKUP_DATABASE=1）**。回退只恢复镜像与拉取策略，数据不回退。

本地验证：脱敏快照 API 147 文件/Portal 169 文件（appsettings 6 处 REDACTED，无 .env/.data-protection/App_Data/sk- 明文）；Portal bundle 新域名 2 处、旧域名 0 处；隔离冒烟（真实 PostgreSQL 17）`/health` 200、五个受保护端点含新路由 `recent-apps` 均 401、`Users.AllowCustomModels` 与 `ApplicationClicks`/`ApplicationClickAdjustments` 表正确、Portal 八页 200 且 `/chat` 无 client reference 报错；源码测试后端 200 通过/4 跳过、门户 46 文件 213 通过；tar 重载仍 amd64、prepare.py 20/20、`bash -n` ×3、ZIP 完整性全通过。

已知非阻塞项：门户 `app/admin/plugins/status/page.test.tsx` 有 1 个既存失败（期望 3 次调用、实际 4 次），已通过临时回退本轮改动复验确认与本功能无关，本次未修复。

DSH 安装包本次不构建（用户自行打包）。本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或业务验收**。命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-04-main.2-app-only/README.md)为准。

## 2026-11-04 DSH 自定义模型授权 API/Portal app-only 构建

已基于 `main` 当前工作区构建 `2026-11-04-main.1-app-only` 离线包，包含按用户在 AIGC 中台开启「允许 DSH 自定义模型」的完整后端与门户改动，以及三项 Portal 交互修复。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-04-main.1-app-only`
- 离线包：`output/aigc-update-2026-11-04-main.1-app-only.zip`（191,312,161 字节）
- ZIP SHA-256：`d0e21dd2bbeb9a2c42b409d9d875698e0dd6c5128e2f6e64e494c79eaffc3d4c`
- 镜像：`aigc-api:2026-11-04-main.1`（ID `sha256:52263b555b82...`，100MB）、`aigc-portal:2026-11-04-main.1`（ID `sha256:d762e32932a7...`，92MB），linux/amd64，tar 192,522,240 字节

功能要点：`Users.AllowCustomModels`（默认 false）与 `SaveUserRequest.AllowCustomModels`；`/api/users` 回传、`/v1/auth/me` 与 `/v1/config/snapshot` 的 `capabilities.allowCustomModels`；该字段已进入配置同步 revision 触发条件，改动经既有热更新与回执链路下发；权限变更写 `OperationAudit`。Portal 用户弹窗新增开关，保存提示统一为「保存成功」且 4 秒自动消失（原 `clear-notice` 从未被调用导致浮层常驻），流量包改为图标按钮，虚拟 Key 列表表头/内容居中并修复删除图标与相邻图标不对齐（`DeleteButton` 的 tooltip 包裹层未参与 flex 居中）。同期包含 11-03 应用注册中心/逻辑删除与 11-02 用户同步 MQ/周令牌计费全部内容。

本包只更新 `aigc-api` 与 `aigc-portal` 镜像及 imagePullPolicy；不更新 DSH、MinIO、PostgreSQL、RabbitMQ、ConfigMap、Secret、PV/PVC。**因新增 `Users.AllowCustomModels` 列，update.sh 数据库 dump 默认强制（BACKUP_DATABASE=1）**；列由 API 启动幂等 `ADD COLUMN IF NOT EXISTS` 创建。回退只恢复镜像与拉取策略，列保留（默认 false，无害）。

本地验证：新建脱敏快照（API 147 文件/Portal 167 文件，appsettings 6 处 REDACTED），修正了此前快照误将 `.data-protection`、`App_Data/logs`、`.env*` 打入镜像的问题；镜像内确认无 `appsettings.Development.json`、`.data-protection`、`App_Data`、无 `sk-` 明文；Portal bundle 新域名 2 处、旧域名 `aigcbackend` 0 处；隔离冒烟（真实 PostgreSQL 17）API `/health` 200、四个受保护端点未登录 401、`MQ.UserSync.*` 与 `ConfigSync.MqDisabled` 日志、`ConfigSync*`/`TokenBilling*` 表与 `Users.AllowCustomModels` 列均正确；Portal 六页 200 且 `/chat` 无 client reference 报错；tar `docker load` 重载仍为 amd64、prepare.py 单测 20/20、`bash -n` ×3、ZIP 完整性与内层 SHA-256 全通过。BUILD-INFO.json 记录 314 源文件哈希。

Portal 构建参数按本文件 10-15 记录取 `https://aigcplatform.boschhuayu-steering.com`；`deploy/k8s/bosch-aigc-dsh/build-images.ps1` 与 `package-offline-images.ps1` 里仍写旧的 `aigcbackend` 域名，**下次复用这两个脚本前必须改新域名**。

DSH 安装包本次不构建（用户自行打包）。**自定义模型调用由 DSH 直连，仅部署 API/Portal 不会让旧客户端获得该能力，需同时发布新版 DSH。**

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或自定义模型端到端联调**。导入、预检、更新和回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-04-main.1-app-only/README.md)为准。

## 2026-11-03 Portal /chat 页面热修复 portal-only 构建

已基于 `main` 当前工作区构建 `2026-11-03-main.2-portal-only` 单镜像热修复包。修复 `/chat` 页面运行时错误 `Unexpectedly client reference export 'useDeleteConfirm' is called on server`：`portal/app/components/chat-shell.tsx` 的 `'use client'` 指令原先位于 import 语句之后而失效，整个文件被当作服务端组件，服务端渲染调用客户端 hook 报错；修复为指令移至文件首行。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-03-main.2-portal-only`
- 离线包：`output/aigc-update-2026-11-03-main.2-portal-only.zip`（91,926,766 字节）
- ZIP SHA-256：`b5298630c8db31cf205aeb914c252a45054938bf7d107f30fc47ef1f2f4bcca9`
- 镜像：`aigc-portal:2026-11-03-main.2`（ID `sha256:1d52239f5320...`，397MB），linux/amd64，tar 92,426,752 字节；API 镜像不变，沿用 `aigc-api:2026-11-03-main.1`

本包只更新 `aigc-portal` 容器镜像及 imagePullPolicy；不更新 API、DSH、MinIO、PostgreSQL、RabbitMQ、ConfigMap、Secret、PV/PVC。无数据库结构变化，update.sh 默认不 dump（可 BACKUP_DATABASE=1）。回退恢复原 Portal 镜像及拉取策略。

本地验证：脱敏快照 `.verification/release-20261103-portal-only`（portal 154 文件，沿用 11-02 排除规则）；容器冒烟 `/`、`/login/local`、`/desktop`、`/chat` 均 200 且 `/chat` SSR 无 useDeleteConfirm 错误；镜像内编译期 API 地址为新域名（SSR+client 两份 api-client）、旧域名 0 处、无开发凭据；tar `docker load` 重载、ZIP 完整性、prepare.py 单测 6/6、bash -n ×3 均通过。构建期间 D 盘曾满（100%），清理 Docker 构建缓存并由用户释放空间后完成打包。

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或 /chat 浏览器验收**。导入、预检、更新和回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-03-main.2-portal-only/README.md)为准。业务验收需登录后打开 `/chat` 确认报错消失、对话/删除/工具功能正常，其余页面抽查无回归。

## 2026-11-03 配置热更新与 DSH 设备回执（源码实现，待发布）

新增模型/授权/倍率/计费配方变更版本与事务 Outbox、服务端 RabbitMQ 分发、DSH HTTPS SSE 与版本补偿、应用成功回执，以及 Portal“客户端运维 → 配置更新状态”。管理端可按用户和设备查看目标/已应用版本、最后应答、失败码、离线与未上报状态。首次使用需要同时更新 API、Portal 和 DSH，已有 app-only 离线包不自动包含本次后续源码改动。

复用现有 nj304 MQ 和 `/aigc`；新增 `aigc.config.events` 及最小权限运行账号 `aigc_config_runtime`，保留原三账号。增量拓扑生成器：`deploy/nj304-rabbitmq/prepare-config-sync.py`；运行连接使用 `ConfigSync__*` 配置，密码沿用既有 `aigc-secrets` 的受保护 merge patch 注入方式，不使用管理账号作为运行凭据。默认 MQ 未启用时使用版本补偿，管理页明确显示连接状态。[完整配置、回执语义、代理与验收步骤](docs/DSH-CONFIG-HOT-UPDATE-DEPLOYMENT.md)。尚未修改线上 MQ、Secret 或部署任何新镜像/客户端。

## 2026-11-03 应用注册中心 + 逻辑删除 API/Portal app-only 构建

已基于 `main` 当前工作区（含应用注册中心、中台逻辑删除全部改动）构建 `2026-11-03-main.1-app-only` 离线包。包含：应用注册中心（`RegisteredApplications`/`RegisteredApplicationGrants` 表 + `/api/application-registry` 端点 + Portal `/admin/registry` 注册中心页与 `/admin/usage` 使用统计页，部门/个人授权并集，普通目录不暴露注册应用 URL）；中台逻辑删除（用户/部门/虚拟 Key/客户端版本/计费配方 `DeletedAt` 软删除，EF 全局查询过滤，删除用户撤销桌面会话并产生 `user.deleted` 同步消息，部门有用户拒绝删除，配方有绑定 409）；Portal 删除交互统一为 Ant Design Modal.confirm。同时包含 2026-11-02 with-mq 全部内容（用户同步 Outbox/RabbitMQ、周令牌计费等）。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-03-main.1-app-only`
- 离线包：`output/aigc-update-2026-11-03-main.1-app-only.zip`（191,287,737 字节）
- ZIP SHA-256：`53d753f16b55edc8250f6ad1315e4353e957a84b5b3a5db9ce412523bbdb1529`
- 镜像：`aigc-api:2026-11-03-main.1`（ID `6ae275c2fde8`，351MB）、`aigc-portal:2026-11-03-main.1`（ID `f87ceed81172`，397MB），linux/amd64，tar 192,415,744 字节

本包只更新 `aigc-api` 与 `aigc-portal` 容器镜像及 imagePullPolicy；不更新 DSH、MinIO、PostgreSQL、RabbitMQ、ConfigMap、Secret、PV/PVC。**因新增注册中心两表及多表 `DeletedAt` 可空列（启动幂等创建），update.sh 数据库 dump 默认强制（BACKUP_DATABASE=1）**。回退只恢复两个镜像及拉取策略，软删除列与注册中心表保留（无害），数据不回退。脚本沿用 10-30 app-only 框架（prepare.py 单测 20/20）。

本地验证：脱敏快照（API 193 文件/Portal 178 文件，appsettings 6 处 REDACTED）；API 冒烟 `/health` 200 + application-registry/users-sync/billing 端点未登录 401 + `MQ.UserSync.WorkerStarted/Disabled` 日志 + RegisteredApplications/UserSync/TokenBilling 表与 6 表 DeletedAt 列、Users.SyncVersion；Portal 六页（`/`、`/login/local`、`/desktop`、`/admin/registry`、`/admin/usage`、`/admin/users/sync`）200、旧域名 0 处、新域名已入 api-client bundle；tar 重载、ZIP 完整性与内层 SHA-256、bash -n ×3 均通过；BUILD-INFO.json 371 源文件哈希。DSH 安装包本次不构建（用户自行打包）。

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或注册中心/逻辑删除业务联调**。导入、预检、更新和回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-03-main.1-app-only/README.md)为准。业务验收需确认注册中心登记/翻译/授权/门户可见、使用统计页、各管理页删除确认弹窗及软删除后列表隐藏，以及 2026-11-02 with-mq 尚未完成的验收项。

## 2026-11-02 用户同步 RabbitMQ + API/Portal with-mq 构建

已基于 `main` 当前工作区（含用户同步 MQ、周令牌计费全部改动）构建 `2026-11-02-main.1-with-mq` 离线包。这是首个含 RabbitMQ Kubernetes 资源的交付：除 API/Portal 镜像外，新增 nj304 固定的 MQ Deployment/Service/ConfigMap/Secret/PV/PVC。包含：后端 UserSync Outbox（`UserSyncMessages`/`UserSyncBatches` 表 + `Users.SyncVersion`）、`RabbitUserSyncPublisher`（RabbitMQ.Client 7.2.2、publisher confirms、`MQ.UserSync.` 6200-6231 日志）、Portal `/admin/users/sync` 页面；版本强制更新、Token 增量包、新用户本地模型绑定；周令牌计费（10-30 全部内容）。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-11-02-main.1-with-mq`
- 离线包：`output/aigc-update-2026-11-02-main.1-with-mq.zip`（309,238,800 字节，v3 含完整 UserSync 启用命令与 MQ 密码生成模式）
- ZIP SHA-256：`13870c6fd5a2069e3448921c62e2bb2ee4d8117f200494a486145f7f396be9dd`
- 镜像：`aigc-api:2026-11-02-main.1`（ID `07ef7c630761`，351MB）、`aigc-portal:2026-11-02-main.1`（ID `95ba29cd52de`，397MB）、`rabbitmq:4.2-management`（ID `d1fb8b38bd08`，391MB，复用已验证拉取），linux/amd64，tar 313,122,816 字节

MQ 部署要点：nodeSelector `kubernetes.io/hostname=bosch-k8s-node-nj304` + 标签 `aigc.bosch/node: nj304`；local PV（`Retain`）+ 同节点 nodeAffinity；密码两种方式——手动 export `MQ_ADMIN_PASSWORD`/`MQ_PRODUCER_PASSWORD`/`MQ_CONSUMER_PASSWORD`（默认），或 `MQ_PASSWORD_MODE=generate` 让 prepare.py 为缺省变量生成 24 位随机密码（一次性打印在输出中，当场存档，之后不可找回；manifest 只存带盐哈希，umask 077）；数据库 dump 默认强制。回退删 MQ Deployment/Service 但保留 PVC/PV/Secret/ConfigMap 与数据。**`UserSync.Enabled` 默认 false（采集但不连接 MQ）**；业务验收前用 `UserSync__*` 键 merge patch `aigc-secrets`（HostName 用 Service 名 `aigc-mq`）并重启 API。

本地验证：脱敏快照（API 132 文件/Portal 136 文件，appsettings 6 处 REDACTED，UserSync 无密码）；API 冒烟 `/health` 200 + sync 端点未登录 401 + `MQ.UserSync.WorkerStarted/Disabled` 日志 + UserSync/TokenIncrement/TokenBilling 表与 SyncVersion/IsMandatory 列；Portal 四页 200、旧域名 0 处；RabbitMQ 以 K8s 同构挂载冒烟（ping/vhost/exchange/quorum 队列/绑定/三账号最小权限）；prepare.py 单测 26/26；bash -n ×3；tar 重载、ZIP 完整性与 SHA-256 均通过；BUILD-INFO.json 227 源文件哈希。DSH 安装包本次不构建（用户自行打包）。

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment/资源更新或用户同步业务联调**。导入、预检、更新和回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-11-02-main.1-with-mq/README.md)为准。

### 启用用户同步：merge patch 既有 aigc-secrets

MQ 部署完成后（且业务验收准备好时），在 Kubernetes 控制节点执行。API 的连接配置通过既有 `aigc-secrets` 注入，**不创建新 Secret、不替换整个 Secret**——与 2026-10-28 注入 `McpIdentityAssertion__*` 相同方式，merge patch 仅新增/更新 `UserSync__*` 键并保留全部既有键。`UserSync__Password` 填部署 MQ 时 `MQ_PRODUCER_PASSWORD` 的同一个明文密码。命令依赖 `jq`，先准备好密码（放在临时文件，避免进 shell 历史）：

```bash
set -euo pipefail
# 1) producer 明文密码放入临时文件（替换为部署 MQ 时使用的同一密码）
read -s -p "MQ producer password: " MQ_PRODUCER_PASSWORD; echo
printf '%s' "$MQ_PRODUCER_PASSWORD" > /tmp/aigc-mq-producer-password
chmod 600 /tmp/aigc-mq-producer-password

# 2) 生成 merge patch（stringData 由 K8s 完成 base64，保留既有键）
jq -n --rawfile password /tmp/aigc-mq-producer-password '{
  stringData: {
    "UserSync__Enabled": "true",
    "UserSync__HostName": "aigc-mq",
    "UserSync__Port": "5672",
    "UserSync__VirtualHost": "/aigc",
    "UserSync__Exchange": "aigc.identity.users",
    "UserSync__UserName": "aigc_user_producer",
    "UserSync__Password": $password
  }
}' > /tmp/aigc-usersync-secret-patch.json
chmod 600 /tmp/aigc-usersync-secret-patch.json

# 3) 应用并重启 API
kubectl -n bosch-aigc-dsh patch secret aigc-secrets \
  --type merge \
  --patch-file /tmp/aigc-usersync-secret-patch.json

kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-api
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=300s

# 4) 清理临时文件
rm -f /tmp/aigc-mq-producer-password /tmp/aigc-usersync-secret-patch.json
```

不回显值的存在性检查：

```bash
for key in UserSync__Enabled UserSync__HostName UserSync__UserName UserSync__Password; do
  value="$(kubectl -n bosch-aigc-dsh get secret aigc-secrets -o "jsonpath={.data.$key}")"
  test -n "$value" || { echo "$key: 未设置"; exit 1; }
  echo "$key: 已设置"
done
```

启用验证：`kubectl -n bosch-aigc-dsh logs deployment/aigc-api -c api --since 5m | grep "MQ.UserSync."` 应出现 `Connected`（若 MQ 未就绪则 `Connecting`/`ConnectionFailed` 重试日志）。随后在「用户管理 → 用户同步」执行一次全量快照并观察发送状态；Outbox 在启用前积累的消息会随后续轮询发出。停用同步改回 `UserSync__Enabled=false` 同法 patch；修改密码轮换时先换 MQ 侧哈希（重跑 prepare.py + apply）再同步更新此 Secret 并重启 API。

## 2026-10-30 周令牌计费 API/Portal app-only 构建

已基于 `main` 当前工作区（含周令牌计费全量改动）构建 `2026-10-30-main.1` app-only 离线包。包含：后端 TokenBilling 配方/分配/预占/结算四表（启动幂等建表）、`/api/billing/plan-options` 端点、用户/部门保存写入计费配方分配（User 优先于 Department 继承）；Portal 独立「计费管理」栏目（计费配方 + 用户报表，recharts 按日趋势/部门/模型 Top 图表）、用户管理与部门管理弹窗内嵌配方选择。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-10-30-main.1-app-only`
- 离线包：`output/aigc-update-2026-10-30-main.1-app-only.zip`（190,828,043 字节）
- ZIP SHA-256：`c9e72d8626217d28ee5d949300c8dd69c38d3d57309b578412ea724d1cb119da`
- 镜像：`aigc-api:2026-10-30-main.1`（ID `78eaf7f0fbc0`，350MB）、`aigc-portal:2026-10-30-main.1`（ID `d3e03633ff02`，396MB），linux/amd64，tar 192,053,248 字节

本包只更新 `aigc-api` 与 `aigc-portal` 容器镜像及 imagePullPolicy；不更新 DSH、MinIO、PostgreSQL、ConfigMap、Secret、PV/PVC。**因新增 token_billing_* 四张表，update.sh 将数据库 dump 从可选改为默认强制（BACKUP_DATABASE=1）**；表由 API 启动时幂等创建，无需手动迁移。回退只恢复两个镜像及拉取策略，数据不回退。

本地验证：镜像脱敏（appsettings.json 6 处 REDACTED，无开发凭据）；API DLL 含 `api/billing/plan-options` 路由；Portal 旧域名 0 处、billing 路由与 recharts 已打包；隔离冒烟 API `/health` 200（真实 PostgreSQL）+ plan-options 未登录 401，Portal `/`、`/login/local`、`/desktop` 均 200；prepare.py 单测 20/20；BUILD-INFO.json 201 源文件哈希与工作区一致；tar 重新加载与 ZIP 完整性通过。

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或计费业务联调**。导入、预检、更新、验证和回退命令以[本次交付说明](deploy/k8s/bosch-aigc-dsh/update-2026-10-30-main.1-app-only/README.md)为准。业务验收需确认计费管理栏目、配方 CRUD、报表图表渲染，以及 DSH 新客户端（含 2026-10-30 源码）的配额/预占/结算端到端一致性。

## 2026-10-29 KnowEngine assertion `iat` API 热修复交付

已基于 `main` 当前工作区构建 API-only 热修复 `2026-10-29-main.1`。生产已部署的 `2026-10-28-main.1` 构建早于 `iat` 修复；本版本在 RS256 assertion Payload 中显式写入整数型 Unix 秒 `iat`，并保留原有 `nbf`、`exp`、`iss`、`aud`、`sub`、`jti`、`kid` 和员工声明语义。

- 交付目录：`deploy/k8s/bosch-aigc-dsh/update-2026-10-29-main.1-api-only`
- 离线包：`output/aigc-update-2026-10-29-main.1-api-only.zip`
- ZIP SHA-256：`db554bfc9ef3222dce036b880635518d5c55dab0b15653ccae95c32a913cecbb`
- 镜像：`aigc-api:2026-10-29-main.1`，ID `sha256:fbf18cb2aff5380d911fe69b8342342cdf2eff922a18bd9bd4ac200282e9a279`，linux/amd64

本包只更新 `aigc-api` 容器的 image 与 imagePullPolicy；不更新 Portal、DSH、MinIO、PostgreSQL、ConfigMap、Secret、PV/PVC、卷、initContainer 或节点约束。继续复用已注入 `McpIdentityAssertion__*` 的现有 `aigc-secrets`，不要创建新 Secret 或重新写入私钥。本版本无数据库结构变化，默认不执行数据库 dump。

本地验证：`McpMarketHttpTests` 6/6 通过，其中回归测试明确要求 `iat` 存在且 `nbf <= iat <= exp`；API-only 部署脚本测试 16/16 通过；Bash 语法、脱敏镜像内容、TAR 重新加载、linux/amd64 平台、目录及 ZIP 内 `SHA256SUMS` 全部通过。构建使用独立脱敏快照，不含 `appsettings.Development.json`、生产私钥或本地数据。

本次仅完成本地构建和离线交付，**尚未执行生产 CHECK_ONLY、镜像导入、Deployment 更新或 KnowEngine 真实联调**。导入、预检、更新、验证和回退命令以[本次API热修复说明](deploy/k8s/bosch-aigc-dsh/update-2026-10-29-main.1-api-only/README.md)为准。生产更新后运行包内 `verify-knowengine-mcp.sh`，先确认 assertion Payload 含 `iat`，再验证 KnowEngine Token Exchange、MCP初始化、工具发现与员工ACL。

## 2026-10-28 KnowEngine MCP 身份断言生产密钥注入

用户已反馈按 `update-2026-10-28-main.1-app-only` 交付物完成部署，但本记录未直接连接生产集群复核镜像、Pod 或业务接口。用户随后提供的生产查询显示：namespace 为 `bosch-aigc-dsh`，API Deployment 为 `aigc-api`，现有 `Opaque` Secret 为 `aigc-secrets`；该 Secret 当时尚未包含 `McpIdentityAssertion__*` 四项。输出中已有凭据值不得复制进仓库、工单或聊天记录。

AIGC API 通过现有 `aigc-secrets` 取得敏感配置。不要创建同用途的新 Secret，也不要使用只包含四个新键的清单替换整个 `aigc-secrets`；必须使用 merge patch，仅新增或更新下列配置：

```text
McpIdentityAssertion__Issuer=bhss-aigc
McpIdentityAssertion__KeyId=aigc-2026-10
McpIdentityAssertion__PrivateKeyPem=<AIGC 私钥 PEM，仅秘密注入>
McpIdentityAssertion__LifetimeSeconds=60
```

Kubernetes Secret 的 `data` 字段显示为 Base64 编码，不代表加密；不要输出或提交完整 Secret YAML。生产私钥只保存在 AIGC 侧，公司密钥库保留备份；KnowEngine 只接收交接包中的公钥、指纹、`kid`、issuer、audience 和改造说明。

在 Kubernetes 控制节点执行以下命令。先通过受控方式把私钥临时放到 `/tmp/aigc-mcp-aigc-2026-10-private-key.pem`；命令依赖 `jq`，利用 `stringData` 让 Kubernetes 完成 Base64 转换，并保留 `aigc-secrets` 的全部既有键：

```bash
set -euo pipefail

PRIVATE_KEY=/tmp/aigc-mcp-aigc-2026-10-private-key.pem
PATCH_FILE=/tmp/aigc-mcp-secret-patch.json

test -s "$PRIVATE_KEY"
chmod 600 "$PRIVATE_KEY"

jq -n \
  --arg issuer 'bhss-aigc' \
  --arg keyId 'aigc-2026-10' \
  --arg lifetime '60' \
  --rawfile privateKey "$PRIVATE_KEY" \
  '{
    stringData: {
      "McpIdentityAssertion__Issuer": $issuer,
      "McpIdentityAssertion__KeyId": $keyId,
      "McpIdentityAssertion__PrivateKeyPem": $privateKey,
      "McpIdentityAssertion__LifetimeSeconds": $lifetime
    }
  }' > "$PATCH_FILE"
chmod 600 "$PATCH_FILE"

kubectl -n bosch-aigc-dsh patch secret aigc-secrets \
  --type merge \
  --patch-file "$PATCH_FILE"

kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-api
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=300s

rm -f "$PATCH_FILE" "$PRIVATE_KEY"
```

不输出值的配置存在性检查：

```bash
for key in \
  McpIdentityAssertion__Issuer \
  McpIdentityAssertion__KeyId \
  McpIdentityAssertion__PrivateKeyPem \
  McpIdentityAssertion__LifetimeSeconds
do
  value="$(kubectl -n bosch-aigc-dsh get secret aigc-secrets -o "jsonpath={.data.$key}")"
  test -n "$value" || { echo "$key: 未设置"; exit 1; }
  echo "$key: 已设置"
done
```

Secret 注入和 rollout 成功只证明 AIGC Pod 已取得配置，不代表 KnowEngine 端到端联调成功。KnowEngine 改造并部署后，还必须使用已授权员工完成：AIGC `/v1/mcp/{id}/identity-assertion` 签发、KnowEngine `/oauth2/dsh-token` 兑换、携带 Bearer Token 调用 `/mcp`，并确认员工 ACL、Token 到期自动续换、退出/撤权后连接清理。接口合同与密钥轮换要求见 [KnowEngine MCP 无感身份交换改造说明](docs/KNOWENGINE-MCP-TOKEN-EXCHANGE.md)。

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
