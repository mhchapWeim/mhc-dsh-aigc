# AIGC 更新包 2026-10-10.1

依据 DEPLOYMENT-RUNBOOK.md、当前 Dockerfile 和部署清单生成。API、Portal 镜像为 linux/amd64；本包不包含 DSH 客户端安装包。本包未连接或部署线上 Kubernetes。

## 本次内容

- 插件市场独立一级菜单，拆分插件管理和客户端状态表格，各自分页；状态接口移除 500 条截断。
- 模型、搜索、插件、虚拟 Key 授权支持跨分页全选；角色页面权限支持全选。
- 独立博查搜索、内网 OpenAI 兼容模型插件；复用 AIGC 本地模型配置及授权。

## 文件

- aigc-update-2026-10-10.1-linux-amd64.tar：aigc-api:2026-10-10.1、aigc-portal:2026-10-10.1。
- api-update.patch.json、portal-update.patch.json：镜像补丁，imagePullPolicy: Never。
- update.sh、rollback.sh：校验、备份、更新、回滚脚本。
- plugins/：独立插件包，管理员在插件管理中上传、授权并发布。
- SHA256SUMS：交付目录内所有文件校验。

## 上传与导入

zip 上传控制节点，以下命令均为 Bash：

```bash
mkdir -p ~/aigc-update-2026-10-10.1
unzip ~/aigc-update-2026-10-10.1.zip -d ~/aigc-update-2026-10-10.1
cd ~/aigc-update-2026-10-10.1
sha256sum -c SHA256SUMS
kubectl -n bosch-aigc-dsh get deploy aigc-api aigc-portal aigc-postgres -o wide
kubectl -n bosch-aigc-dsh get pods -o wide
scp aigc-update-2026-10-10.1-linux-amd64.tar nj00663@172.28.2.33:~/
```

nj304：

```bash
sudo ctr -n k8s.io images import --platform linux/amd64 ~/aigc-update-2026-10-10.1-linux-amd64.tar
sudo crictl images | grep -E 'aigc-api|aigc-portal'
```

确认两镜像的 2026-10-10.1 标签已加载，再在控制节点执行：

```bash
cd ~/aigc-update-2026-10-10.1
bash update.sh
```

脚本依赖 python3、kubectl、SSH/sudo 和 PostgreSQL 容器中的 pg_dump。先核对现场 Deployment、容器名和 nj304 固定调度；不一致时脚本停止。不要 apply 整套旧 YAML，不重建数据卷。

## 数据和配置

脚本先备份数据库、Deployment 和 ConfigMap，再顺序更新 API、Portal 并等待 rollout。新 API 启动执行现有增量建表流程，包括插件、版本、回报表和权限补齐。

插件包、客户端安装包必须持久化。保留已有 Plugins__StoragePath、DesktopReleases__Root；未配置时分别使用现有 dsh-uploads PVC 下的 managed-plugins、desktop-releases 目录。脚本校验可写 PVC，并在替换前复制旧容器默认路径中的文件，不覆盖同名文件。共享原上传卷容量，请核对剩余空间。无法验证的 valueFrom 或非持久化路径会使更新在换镜像前停止，先修正配置再重试。

保留 DataProtection 卷和原加密密钥。Portal 构建时 API 地址固定为 https://aigcbackend.boschhuayu-steering.com。保留 Cas、LiteLLM PublicBaseUrl、代理和 TLS 配置。本包不包含生产密钥，不自动发布插件或客户端版本。

## 验证与回滚

```bash
kubectl -n bosch-aigc-dsh logs deploy/aigc-api --tail=80
kubectl -n bosch-aigc-dsh logs deploy/aigc-portal --tail=50
curl -I https://aigcbackend.boschhuayu-steering.com/login
```

管理员重新登录获取 plugin.manage 权限，验证独立菜单、分页、授权全选、上传及发布。安装新 DSH 后登录、同步并重启，确认插件状态回报。内网模型的 Key 在模型管理中配置，博查 Key 在插件发布中配置。

使用 update.sh 输出的真实备份目录：

```bash
bash rollback.sh backup-YYYYMMDD-HHMMSS
```

回滚恢复旧镜像、拉取策略及 API 显式环境变量，保留新增表、插件文件和数据卷，不自动恢复 database.dump。

## DSH 客户端

DSH 客户端由使用方独立打包，本次不包含安装包或客户端打包命令。plugins/ 中的文件是独立功能插件 bundle，不是 DSH 安装包。
