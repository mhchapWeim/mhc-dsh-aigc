# AIGC / DSH 更新 2026-10-12.3

依据根目录 DEPLOYMENT-RUNBOOK.md。本包更新 API、Portal，附内网模型插件 1.0.1；Windows 客户端安装包单独交付。命名空间 bosch-aigc-dsh，目标节点 bosch-k8s-node-nj304 (172.28.2.33)。本机未连接生产 Kubernetes，以下命令须在现场执行。

## 更新内容

- 客户端品牌统一为“弯崽工作伙伴”，首页问候为“今天有什么需要我来办的?”；各处图标使用修复透明通道的弯崽形象。
- 修复持久会话计时参数缺少默认值导致打开认证窗口时报“无法连接后端”的问题。
- 用户反馈列表筛选、表格、分页及详情弹窗对齐现有后台样式，长内容可滚动。样式规范见 PORTAL-ADMIN-STYLE.md。

- DSH 反馈保存到 AIGC，管理后台 `/admin/dsh-feedback` 查看反馈及会话日志，需要 diagnostic.manage 权限。
- AIGC 密码和 CAS SSO 登录均签发持久会话；客户端重启恢复登录并续期访问令牌，手动退出撤销持久会话。
- 旧客户端凭据没有刷新令牌，升级后需重新登录一次。账号禁用或服务端会话撤销仍会使认证失效。
- 镜像标签均为 2026-10-12.3，架构 linux/amd64。保留现有 CAS、LiteLLM、TLS 和 PVC 设置。

## 1. 控制节点 bosch-k8s-nj-master / 172.28.2.26

将 aigc-update-2026-10-12.3.zip 上传到此节点家目录，然后执行：

```bash
mkdir -p ~/aigc-update-2026-10-12.3
unzip ~/aigc-update-2026-10-12.3.zip -d ~/aigc-update-2026-10-12.3
cd ~/aigc-update-2026-10-12.3
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get deployments,pods -o wide
scp aigc-update-2026-10-12.3-linux-amd64.tar nj00663@172.28.2.33:~/
```

## 2. 工作节点 bosch-k8s-node-nj304 / 172.28.2.33

```bash
sudo ctr -n k8s.io images import --platform linux/amd64 ~/aigc-update-2026-10-12.3-linux-amd64.tar
sudo crictl inspecti docker.io/library/aigc-api:2026-10-12.3 >/dev/null
sudo crictl inspecti docker.io/library/aigc-portal:2026-10-12.3 >/dev/null
```

## 3. 返回控制节点执行更新

```bash
cd ~/aigc-update-2026-10-12.3
bash update.sh
kubectl -n bosch-aigc-dsh get pods -o wide
kubectl -n bosch-aigc-dsh logs deployment/aigc-api --tail=80
curl --fail https://aigcbackend.boschhuayu-steering.com/health
```

update.sh 先校验文件和 nj304 镜像，再检查调度及插件/安装包存储 PVC，备份部署、ConfigMap 和数据库，依次更新 API、Portal 并等待 rollout。数据库新增反馈与持久会话表由 API 启动自动完成，不需要手工执行 SQL。备份目录权限受 umask 077 保护，应留在控制节点。

若工作节点 SSH 用户不同：`NJ304_SSH_TARGET=用户名@172.28.2.33 bash update.sh`。

## 4. Windows 客户端和内网模型插件

Windows x64 安装包版本 0.1.7-alpha.2.20261012.2，交付 unsigned.exe、blockmap 和校验文件。退出客户端后运行安装包，重新登录一次。包为未签名构建；已有签名客户端需要手工安装该基线，不能将其作为签名更新链直接推送。

中台“插件市场”上传 `plugins/bhss-dsh-plugin-internal-model-1.0.1.tgz`，选中该版本发布，保留现有配置和用户/角色/部门授权。上传成功不代表已发布。客户端同步后按提示重启，检查实际插件版本为 1.0.1。

若通过中台发布客户端：在“客户端版本发布”上传本次 installer 及 blockmap，核对 win-x64、版本和灰度范围后发布；不要使用旧版本产物。本次未自动修改生产发布策略。

## 5. 现场验收

分别用 AIGC 密码和 SSO 登录客户端，关闭所有客户端进程再打开，确认保持登录；点击退出后重新启动，确认需要登录。提交包含类别和文字的反馈，在管理后台“用户反馈”查看内容及日志。真实 SSO、企业终端安装策略和集群 rollout 需现场验证；本包已通过本地镜像 API/Portal 启动、反馈保存、刷新令牌和退出撤销检查。

## 回滚（控制节点）

```bash
cd ~/aigc-update-2026-10-12.3
bash rollback.sh "$(cat LAST_BACKUP)"
```

LAST_BACKUP 在成功更新后记录本次备份目录。若更新中途失败，使用 update.sh 已打印的 Backup directory 执行 `bash rollback.sh backup-实际时间`。回滚保留新增表及新数据，不直接用旧数据库 dump 覆盖。插件和客户端的发布版本需要在对应管理页面单独回退。
