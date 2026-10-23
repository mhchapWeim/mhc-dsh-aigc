# DMZ LiteLLM 离线升级包

修订 fix2（2026-10-23，包含 fix1）：预备和最终备份的目录校验改用 `pg_restore --list` 直接从标准输入读取，不再传 `/dev/stdin` 文件名。新增备份格式头检查、分步提示及私有失败 stderr 日志（目录 `.upgrade-errors/` 权限 700，文件 600，不记录命令参数、stdout 或备份正文）。已用真实 PostgreSQL 17.10 验证两次备份、校验和删除重建恢复，数据一致；详见 PG-VALIDATION.json。仅更新脚本小包即可，镜像不变。

修订 fix1（2026-10-23）：修复 Docker 使用 containerd 镜像存储时，导入后的本地镜像 ID 与归档配置摘要不同而导致 inspect 失败的问题。按明确版本标签识别，校验归档与已导入镜像的平台、全部层及启动配置，再固定 Docker 实际返回的本地 ID。修复不修改镜像正文、数据库或现有服务配置。已经上传旧包时只需应用 fix1-scripts 小补丁，无需重传镜像。

目标服务器：192.168.10.30。本次目标版本：v1.106.2。平台：Linux amd64/x86_64。
后续重新制包后，以 image.json 的 version/archive 和实际生成的 ZIP 文件名为准；本文命令以本次 v1.106.2 交付为例，VALIDATION.md 记录的是本次交付证据。
本包用于已有 Docker Compose LiteLLM 的升级和回退，不安装 Docker Engine，也不新建生产数据库。
本次按用户指定版本升级；从 v1.103.0 跨越多个版本，须演练数据库迁移和恢复。未来换版本时使用本文末尾的制包步骤。

## 一、包内文件

| 文件 | 用途 |
| --- | --- |
| litellm-v1.106.2-linux-amd64.tar.gz | 完整离线 Docker 镜像，可由 docker load 导入 |
| check.sh | 只读识别部署、检查数据库连通性、就绪状态及镜像文件校验 |
| upgrade.sh | 镜像导入、旧镜像和配置备份、数据库备份、升级及就绪检查 |
| rollback.sh | 恢复旧镜像及升级前数据库 |
| service.sh | 升级后的状态查询、启动和停止，仅操作 LiteLLM 服务 |
| manager.py | Python 标准库实现，无 pip 依赖 |
| image.json / SHA256SUMS | 源镜像标识、平台、来源 digest、完整性校验；运行时 ID 由本机 Docker 识别 |
| cosign.pub / signature-verification.json | 固定来源公钥、制包时官方镜像验签结果 |
| prepare-release.sh / package.py | 后续版本制包工具 |
| fetch-image.py | 本次无 Docker daemon 环境下的固定版本下载/重打包工具 |
| test_manager.py / VALIDATION.md | 流程测试及本次验证边界 |

## 二、适用条件

- Linux amd64，Bash、Python 3.8+、Docker Engine 和支持 `config --format json`、`config --hash`、`up --pull never` 的 Compose v2+。
- 运行中的单实例官方普通 `litellm` 镜像，且由 Compose 管理；保留原 Compose 文件和工作目录。
- 可从 `LITELLM_MASTER_KEY` 或 `--config` 指定的 YAML 中解析有效 Master Key。v1.104.0 起拒绝未设置、空值和已知默认值（如 sk-1234）；检查只输出状态，不显示密钥，不自动修改或轮换密钥。无法解析的配置会在停服前停止。
- 运行环境包含 `DATABASE_URL`，指向同机独立 PostgreSQL 容器的网络别名/IP及内部 5432 端口。
- 数据库只供该 LiteLLM 使用；没有第二个 LiteLLM 实例、外部应用或其他写入者共用该数据库。
- PostgreSQL 容器内可用 `POSTGRES_USER`（默认 postgres）通过本地 socket 执行 psql、pg_dump、pg_restore；管理员有创建/删除数据库权限。脚本不索取或输出密码。
- LiteLLM 本机 `/health/readiness` 无需认证且正常。默认 `http://127.0.0.1:4000/health/readiness`。
- LiteLLM 自身 bind mount 总文件大小不超过 256MiB、没有符号链接/特殊设备，且无可写命名卷。PostgreSQL 数据卷正常保留，不受此限制。

如果是 docker run、数据库连接只写在 YAML、外部数据库、host 网络数据库、database/non_root 镜像、多副本、复杂数据卷或源配置已被改动，工具会拒绝自动升级。应基于真实启动定义/数据库拓扑适配后执行，不能修改检测条件强行跳过。

Compose 文件、环境文件和宿主 bind 配置不要在升级、回退期间另行修改。升级包不修改 Nginx、DNS、TLS、博查、ASR、Kubernetes 或 AIGC 配置。LiteLLM 停止期间经过它的请求会短暂失败，正在进行的流式请求最多等待 `--drain-seconds`（默认 120 秒），超时可能被终止。维护窗口须安排用户停止调用；本工具不自动封禁外部流量。

## 三、上传、解压和只读检查

将 ZIP 和 ZIP.sha256 上传服务器同一目录，在 Linux Bash 执行：

```bash
sha256sum -c litellm-upgrade-v1.106.2-linux-amd64.zip.sha256
unzip litellm-upgrade-v1.106.2-linux-amd64.zip
cd litellm-upgrade
sha256sum -c SHA256SUMS
sudo bash check.sh
```

若有多个 LiteLLM 容器，用真实容器名指定；下方名称仅为历史线索，以现场为准：

```bash
sudo bash check.sh --container litellm-litellm-1 --db-container litellm_db
```

check.sh 不加载镜像、不备份、不停止或重建服务。它会连接数据库执行 SELECT 查询，以及读取 LiteLLM 包版本；不会修改业务数据。它不等于数据库恢复演练或完整业务验收。

跨版本注意：如果旧 Master Key 不符合新版要求，先按官方轮换与加密迁移流程处理，再重新检查。旧 Master Key 可能用于加密数据库凭据，不能直接替换；本包不会绕过新版检查。参考 https://docs.litellm.ai/docs/proxy/master_key_rotations#proxy-refuses-to-start 。

同时在现场检查（不要对外粘贴带密码的 inspect/config 输出）：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
df -h
docker exec litellm-gateway nginx -t
```

确保备份目录和 Docker 数据目录都具备空间：至少能存放新镜像、旧镜像 tar、两份数据库 dump、配置备份以及增长余量。脚本有基础空间检查，数据库很大时仍需人工按实际数据量评估。

先在隔离环境复制现有部署和数据库，使用独立端口及数据库演练升级/回退。禁止让测试 LiteLLM 连接生产数据库。若启用模型轮询、webhook、定时任务，先隔离或禁用演练环境的外部副作用。

## 四、正式升级

安排维护窗口，暂停相关用户调用和后台管理写入。确认该数据库专用后运行：

```bash
sudo bash upgrade.sh --dedicated-database
```

需要显式指定容器时：

```bash
sudo bash upgrade.sh \
  --container litellm-litellm-1 \
  --db-container litellm_db \
  --dedicated-database \
  --drain-seconds 120 \
  --timeout 300
```

`--dedicated-database` 是执行者对数据库独占的声明，脚本无法证明其他机器上没有写入者。不要对共享业务数据库使用该参数。

脚本执行顺序：

1. 识别容器及原 Compose；比对源配置 hash 和运行容器，避免覆盖尚未部署的配置。
2. 校验离线镜像 SHA256，检查平台和版本，只允许版本提升。
3. 导入镜像，在无网络临时容器中读取包版本，不连接数据库或挂载生产目录。
4. 在原 Compose 工作目录下创建 `.litellm-upgrade/UTC时间-PID/`，权限 700，敏感文件 600。
5. 保存原镜像 tar、已解析 Compose 快照、bind 配置归档、预备数据库 dump，并检查 dump 可读性。
6. 创建 pending 状态，只停止 LiteLLM 服务，等待请求退出，再生成最终数据库备份和校验清单。
7. 仅通过 `up -d --no-deps --pull never --force-recreate 实际LiteLLM服务` 启动固定 image ID 的新版本。
8. 等待容器运行且 readiness 连续三次通过；若定义了 Docker healthcheck，它也必须 healthy。
9. 保存 current 状态，输出备份路径及后续管理方法。

Compose 快照包含解析后的敏感环境变量，不要上传到 Git、公开目录或工单。备份还包含原加密密钥配置；不要删除或轮换它们再尝试读取旧凭据。脚本不改变原 Compose/YAML/.env，也不会重建依赖服务或执行 down -v。

**升级后管理入口**：原 Compose 文件保留着旧镜像引用，直接执行原来的 `docker compose up` 可能把版本降回。后续请用本包的 service.sh；新版本快照及镜像 ID 已持久保存。

```bash
# WORKDIR 替换为 check.sh/upgrade.sh 输出的真实 Compose 工作目录
sudo bash service.sh --workdir /实际/Compose/工作目录 status
sudo bash service.sh --workdir /实际/Compose/工作目录 up
sudo bash service.sh --workdir /实际/Compose/工作目录 stop
```

以后继续使用 upgrade.sh 时，脚本从当前容器的 Compose 标签找到当前快照并生成下一次独立备份。不要删除旧快照或整个 .litellm-upgrade 目录；容器管理仍依赖其中的配置文件。

## 五、升级后验收

脚本成功只说明镜像、容器和本机 readiness 通过。恢复正常使用前，还应逐项验证：

- 原有管理员和虚拟 Key 鉴权正常，无效 Key 被拒绝。
- 模型列表、AIGC 模型同步、/model/info 和所需能力信息正常。
- 用原有 Key 完成普通聊天、SSE 流式聊天、工具调用及实际使用的视觉等能力测试。
- 用户/团队/模型/预算/历史记录保留；新请求费用和额度正确。
- 经过 DMZ HTTPS 和内网 30443 路径完成真实对话，DSH 端可用。
- 博查真实搜索可用；若 ASR 已上线，则完成握手与识别回归。
- 检查容器重启次数、错误率、耗时、CPU/内存和数据库日志。

不要把密钥写在共享命令历史或验收日志中。完整业务验收和观察完成后结束维护窗口。

## 六、失败与回退

脚本失败会返回非零；一旦进入停服阶段，保留 `.litellm-upgrade/pending.json`。不会自动把旧程序连接到可能已迁移的数据库；后续 upgrade.sh/service.sh 会阻止继续操作。

先按现场实际容器名查看日志，分享前脱敏：

```bash
docker logs --tail 100 litellm-litellm-1
```

fix2 起失败提示会区分 pg_dump、pg_restore、psql，并给出本次私有 stderr 文件的绝对路径。用 sudo 在服务器本地查看该文件；分享错误前先检查敏感信息，不要上传 context.json、Compose 快照或数据库备份。预备备份校验完成以前不会创建 pending.json，也不会停止 LiteLLM。

pending.json 中的 backup 字段或升级输出给出了真实备份目录。执行回退：

```bash
sudo bash rollback.sh \
  --backup /实际/Compose/工作目录/.litellm-upgrade/实际备份目录 \
  --restore-database
```

回退行为：

- 如果新版尚未尝试启动：恢复旧服务，保留当前数据库，不执行数据库重置。
- 如果新版已尝试启动：校验备份完整性、停止 LiteLLM、另存回退前数据库、禁止目标库新连接并终止已有连接、删除并通过 pg_restore --create 恢复升级前专用库，随后启动旧镜像并检查 readiness。
- 新库的创建参数、原有数据库所有权、对象和权限由自包含 dump 恢复；数据库角色仍留在原 PostgreSQL 集群中。工具不升级 PostgreSQL、不删除其数据卷。
- 数据库恢复失败时保持停服；修复原因后对相同备份重新执行回退命令，可以继续恢复。已完成回退会拒绝重复覆盖数据库。
- 回退前 dump 保留升级后的写入，便于人工核对；不会自动合并这些写入。

**--restore-database 会覆盖升级后新增的 Key、模型配置、用量等数据。** 因此要在维护窗口验收并尽早决定是否回退。只允许回退当前或最近一次未完成升级，不能任意跨版本回退。

bind-mounts.tar.gz 是配置应急备份。升级器不会修改宿主配置，也不会在回退时盲目覆盖期间发生的人工改动；如宿主配置发生变化，先人工核对并按 bind-mounts.json 映射恢复，再执行回退。Nginx 的配置不在 LiteLLM 的自动恢复范围。

## 七、后续复用及制备其他版本

目标 DMZ 上运行 check/upgrade/rollback/service 均无需互联网、pip 或 cosign。

未来升级其他版本时，将本目录复制到有外网的 Linux 制包机，安装 Docker、cosign、curl、gzip、Python 3，然后执行：

```bash
# 示例仅说明格式；先审阅目标版本发布说明、迁移和安全状态
bash prepare-release.sh v1.106.2
```

脚本从固定提交获取官方公钥，先 cosign 验证具体版本，将签名里的 digest 固定下来，再按该 digest 拉取 linux/amd64 镜像，生成新 image.json、离线镜像、SHA256SUMS 和 ZIP。不使用浮动标签，拒绝 v1.107.0、rc 和 dev 标签。它不能自动判断未来新版本是否出现新的安全问题，制包前仍需审阅官方公告和发布说明。

制包请在副本中进行且不要并发。旧版归档可能仍留在目录，但 package.py 仅把 image.json 指定的新归档放入 ZIP。`fetch-image.py` 需要 Python 3.11+，固定到本次版本和 digest，不能靠修改版本字符串用于其他版本；通用制包入口是 prepare-release.sh。每次制包后需重新执行对应版本的运行/恢复演练并更新验证记录。

参考：

- https://github.com/BerriAI/litellm/releases/tag/v1.106.2
- https://docs.litellm.ai/docs/proxy/upgrade_guide
- https://github.com/BerriAI/litellm/issues/47826

当前服务器部署形态仍需现场 check 验证；本交付不代表已经连接或升级 192.168.10.30。
