# AIGC 更新 2026-10-14.3

本版本新增弯崽工作伙伴首次安装下载页 `/desktop`，AIGC 首页及应用集合页均有“客户端下载”入口。仅提供 Windows x64。用户使用中台账号登录，无需先安装 DSH 或登记客户端设备，就能下载管理员已发布且授权给自己的安装器。草稿、已暂停、无接收权限或文件缺失时不给出下载。

下载采用 10 分钟 HttpOnly 凭据，文件 URL 不携带 JWT，支持 Range。安装器继续保存在已有 `DesktopReleases__Root` 持久目录，不包含于本 ZIP。上线后需在“客户端发布管理”上传、选择接收范围并发布 Windows x64 安装器。角色/部门接收范围沿用保存时的用户快照，新建用户需要更新接收范围。

本包同时保留此前 SSO 主动退出修复及服务器日志归档功能。客户端安装器由独立 DSH 交付提供，不由本更新包发布。

本版重新构建最新 API/Portal，补入 Bosch SSO 主动退出修复：门户及管理端退出后停留登录页，刷新或认证守卫重定向也不会立即自动登录；用户主动点击 SSO 后仍可重新登录。仅退出中台本地会话，不注销其他企业应用共用的 CAS 会话。此前日志留档与大小限制继续保留。

DSH 客户端由用户自行打包，本交付不启动、包含或发布 DSH 安装器。客户端迁移、标题与样式修复不会由本更新包安装。

包含 API 用户日志与持久归档、Bosch SSO 中台登录、DSH SSO 结果重复轮询修复。Portal `/login` 自动进入 Bosch SSO，`/login/local` 保留工号密码登录。本包不含 DSH 安装器。

镜像：`aigc-api:2026-10-14.3`、`aigc-portal:2026-10-14.3`，均为 linux/amd64。仅完成本地构建和验证，未导入生产节点或上线。实际资源必须与脚本预检一致：命名空间 `bosch-aigc-dsh`，Deployment `aigc-api` / `aigc-portal`，容器 `api` / `portal`，目标节点 `bosch-k8s-node-nj304`。脚本遇到不一致会停止。

## 1. 传输（Windows PowerShell）

```powershell
Set-Location D:\Code\Bosch\aigc\deploy\k8s\bosch-aigc-dsh
Get-FileHash .\aigc-update-2026-10-14.3.zip -Algorithm SHA256
scp .\aigc-update-2026-10-14.3.zip nj00663@172.28.2.33:~/
```

## 2. 导入（nj304 / 172.28.2.33，Bash）

```bash
unzip aigc-update-2026-10-14.3.zip -d aigc-update-2026-10-14.3
cd aigc-update-2026-10-14.3
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import aigc-update-2026-10-14.3-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-14.3 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-14.3 >/dev/null
```

## 3. 更新（控制节点 bosch-k8s-nj-master / 172.28.2.26，Bash）

先将同一 ZIP 传到控制节点并解压，然后执行：

```bash
unzip aigc-update-2026-10-14.3.zip -d aigc-update-2026-10-14.3
cd aigc-update-2026-10-14.3
kubectl -n bosch-aigc-dsh get deploy,pod,pvc -o wide
NJ304_SSH_TARGET=nj00663@172.28.2.33 bash update.sh
```

需要控制节点具备 `kubectl`、`python3`、`ssh`，可 SSH 到 nj304，且该账号有 sudo 权限。脚本检查目标节点镜像，创建 nj304 `/var/lib/aigc-hub/logs`，应用独立 2Gi 静态日志 PV/PVC，备份现有 Deployment、ConfigMap 和数据库，然后更新 API/Portal 并等待完成。现有数据库、Data Protection、上传数据卷保留；已有插件及客户端发布存储配置通过预检确认持久化。新增日志卷为 `Retain`，回滚不删除归档。

日志路径在 API 容器中为 `/var/log/aigc-hub`，在 nj304 主机上为 `/var/lib/aigc-hub/logs`。默认单文件最大 20 MiB，按 UTC 日期和大小滚动，最多 50 个文件、保留 14 天（先触发者先清理），日志正文合计最多约 1000 MiB。2Gi 是 PV 申请容量，不是 local PV 的文件系统硬配额；文件数量和大小由应用限制。归档是滚动保留，到期或达到上限会删除最旧日志。日志实时写入并 flush；磁盘故障时输出明确告警并继续控制台日志，每 30 秒重试文件写入。

可通过 API Deployment 的 `FileLogging__MaxFileSizeBytes`、`FileLogging__MaxFiles`、`FileLogging__RetentionDays` 环境变量调整并重启。日志目录启动时必须可写，否则 API 启动失败，避免出现“已开启归档”但没有文件的情况。成功健康探针不记录 Information 请求日志。

## 4. 验证与查日志

本版下载页验收：访问 `https://aigcbackend.boschhuayu-steering.com/`，点击“客户端下载”，应进入 `/desktop` 并显示弯崽品牌与 Windows x64 下载入口。登录后，若已被加入已发布版本的接收范围，应看到版本、大小和下载按钮；否则显示暂无可下载版本。首次安装不要求设备登记。点击下载应取得 EXE 附件；暂停该版本后再次申请下载应被拒绝。未登录请求 `/api/desktop-downloads/windows-x64` 返回 401 属于正常权限保护。

如暂无安装包：管理员进入“客户端发布管理”，新建版本，上传已验证的 Windows x64 EXE，选择用户/角色/部门接收范围后发布，再用目标账号刷新下载页。本次打包未自动发布任何 DSH 安装器。

控制节点：

```bash
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=300s
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-portal --timeout=300s
kubectl -n bosch-aigc-dsh logs deployment/aigc-api --since=10m --tail=100
kubectl -n bosch-aigc-dsh exec deployment/aigc-api -- sh -c 'ls -lh /var/log/aigc-hub'
curl --fail https://aigcbackend.boschhuayu-steering.com/api/auth/sso/config
```

nj304 主机：

```bash
sudo ls -lh /var/lib/aigc-hub/logs
sudo du -sh /var/lib/aigc-hub/logs
# 替换工号、追踪 ID 后查询；JSONL 每行是一条记录。
sudo grep -F 'wh00028' /var/lib/aigc-hub/logs/aigc-*.jsonl | tail -100
sudo grep -F '替换为追踪ID' /var/lib/aigc-hub/logs/aigc-*.jsonl
sudo grep -E '"LogLevel":"(Error|Warning)"' /var/lib/aigc-hub/logs/aigc-*.jsonl | tail -100
sudo tail -F "$(sudo ls -t /var/lib/aigc-hub/logs/aigc-*.jsonl | head -1)"
```

响应头 `X-Trace-Id` 与异常响应 `traceId` 可关联服务端记录。日志包含时间、级别、类别、路径、方法、状态、耗时、用户 ID、工号、姓名及异常堆栈；匿名请求标注 anonymous，登录成功事件单独记录已验证用户。Portal JWT 和 DSH 托管令牌均支持用户关联。请求体、查询字符串、密码、Cookie 和令牌不作请求日志采集，常见凭据字段和 CAS device 路径会脱敏。

浏览器验收：打开 `/login` 应跳转 Bosch SSO，成功后回到原页面；`/login/local` 可使用原密码登录；DSH 登录和模型列表仍可用。Bosch CAS 服务注册须允许现有 `/v1/auth/cas/callback` 携带 `portal_state` 参数；真实 SSO 需在企业网络验收，本地隔离测试不能替代该步骤。API 和 Portal 同时更新，沿用持久化 Data Protection 密钥。企业 CA 未在本机信任时先配置正确 CA，再做 HTTPS 验证。

## 5. 回滚（控制节点，Bash）

```bash
cd aigc-update-2026-10-14.3
bash rollback.sh "$(cat LAST_BACKUP)"
```

回滚恢复变更前镜像、API 环境变量及卷挂载；保留数据库和日志 PV/PVC，不用旧数据库备份覆盖更新期间新增的数据。备份目录和脚本应妥善保管，内含原配置与数据库备份。
