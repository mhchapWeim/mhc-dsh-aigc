# AIGC 更新包 2026-10-09.1

已读取工作区 DEPLOYMENT-RUNBOOK.md，并核对当前 Dockerfile 和 YAML。本包包含 API 与 Portal 的 linux/amd64 镜像；不包含 DSH 安装包。集群当前状态需要在执行前核验。

## 变更

- DSH 失败日志接收、去重、7 个 UTC 自然日保留、管理员查询和下载。
- 详情居中弹窗、中文错误分类与操作说明。
- 登录页移除预填账号密码；受保护路由登录拦截和登录后返回；登录失效跳转。
- 二级分组菜单、单组展开、收起状态记忆与可点击悬浮子菜单。
- 修复登录守卫导致后台路由切换时布局卸载、闪烁。

## 文件

- aigc-update-2026-10-09.1-linux-amd64.tar：aigc-api:2026-10-09.1 和 aigc-portal:2026-10-09.1。
- api-update.patch.json、portal-update.patch.json：仅更新容器镜像及离线拉取策略。
- update.sh：检查目标节点配置，备份数据库与镜像配置，顺序更新并等待 rollout。
- rollback.sh：恢复此前镜像及拉取策略；保留新增数据库表，不覆盖新数据。
- SHA256SUMS：包内容校验。

## 环境变量

本次没有新增或需修改的环境变量。保留线上 aigc-settings、aigc-secrets 和挂载。门户构建时 API 地址固定为 https://aigcbackend.boschhuayu-steering.com；若入口域名不同，必须重新构建门户镜像。DSH 模型代理仍使用现有 PublicBaseUrl 配置。

## 上传

将 zip 上传控制节点 ~/，镜像 tar 需额外传到 nj304。以下命令均为 Bash。

控制节点：
```bash
mkdir -p ~/aigc-update-2026-10-09.1
unzip ~/aigc-update-2026-10-09.1.zip -d ~/aigc-update-2026-10-09.1
cd ~/aigc-update-2026-10-09.1
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get deploy aigc-api aigc-portal aigc-postgres -o wide
kubectl -n bosch-aigc-dsh get pods -o wide
scp aigc-update-2026-10-09.1-linux-amd64.tar nj00663@172.28.2.33:~/
```

nj304：
```bash
sudo ctr -n k8s.io images import --platform linux/amd64 ~/aigc-update-2026-10-09.1-linux-amd64.tar
sudo crictl images | grep -E 'aigc-api|aigc-portal'
```

确认两个 2026-10-09.1 镜像均已加载，再在控制节点执行：
```bash
cd ~/aigc-update-2026-10-09.1
bash update.sh
```

脚本依赖 python3、kubectl 和 PostgreSQL Pod 中的 pg_dump。只支持 YAML 中的 nj304 固定调度；若线上配置不同，会在更新镜像前停止。本次无需 kubectl apply 整套 YAML，也无需重建数据卷。脚本失败时备份仍保留，按输出的目录执行回滚或排障。

## 验证

```bash
kubectl -n bosch-aigc-dsh logs deploy/aigc-api --tail=80
kubectl -n bosch-aigc-dsh logs deploy/aigc-portal --tail=50
kubectl -n bosch-aigc-dsh get pods -o wide
curl -I https://aigcbackend.boschhuayu-steering.com/login
```

用浏览器退出后重新登录，验证后台路由拦截、分组菜单、悬浮菜单和详情弹窗。平台管理员重新登录获取 diagnostic.manage 权限，在“客户端运维 → DSH 失败日志”查看记录。客户端异步上传必须使用包含本次修复的 DSH；旧客户端需重新打包安装。仅更新中台不会更新桌面客户端。

## 回滚

使用 update.sh 输出的真实备份目录：
```bash
bash rollback.sh backup-YYYYMMDD-HHMMSS
```

保留旧镜像供回滚，不执行镜像清理。database.dump 用于恢复应急，脚本不会自动覆盖数据库。

## DSH Windows 客户端（可选，独立操作）

PowerShell：
```powershell
Set-Location D:\Code\Bosch\aigc\deepseek-harness
pnpm run package:desktop:win:x64:unsigned -- --build-version auto
```

安装包目录：apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts。实际版本以此次打包结果为准；此部署包未执行 DSH 打包。安装新版本并登录后，才使用修正的 /v1/desktop/diagnostics 上传地址。
