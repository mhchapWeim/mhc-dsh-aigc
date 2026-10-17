# AIGC 中台 + API 独立 K8s 部署

桌面端静态试点更新源的部署与发布步骤见 [DESKTOP-PILOT.md](DESKTOP-PILOT.md)；它单独修改边缘 Nginx，不包含在基础 `kustomization.yaml` 中。

目标命名空间 `bosch-aigc-dsh`。已知集群为 Kubernetes 1.28.2，没有 Ingress Controller 或 StorageClass；域名 `aigcbackend.boschhuayu-steering.com` 指向节点 `bosch-k8s-node-nj304` (`172.28.2.33`)。本目录不修改已有的 `bosch-aigc` 命名空间。

## 部署前必须落实

1. 本次使用**全新 PostgreSQL**，不迁移旧数据。部署内含单独的 `aigc-postgres` Deployment/Service，API 首次启动自动建表并初始化示例数据。Secret 中 `POSTGRES_PASSWORD` 必须与连接字符串的 Password 一致。
2. 按 `pv-local.example.yaml` 创建三个静态 PV，分别满足 `aigc-postgres` 20Gi、`aigc-data-protection` 1Gi 和 `aigc-dsh-uploads` 20Gi 的 PVC。集群没有动态存储，现有 Bound PV 不可借用。PV 模板中的 `REPLACE_STORAGE_ROOT` 必须替换成 nj304 上实际存在且容量足够的持久磁盘目录；数据库目录必须为空。PVC 已用 `volumeName` 固定绑定对应 PV，避免 20Gi 卷串绑。
3. LiteLLM 地址已按当前环境配置为 `http://172.28.12.33:4000/v1`。上线前仍需确认 API Pod 和 DSH 同事的电脑都能访问该地址。AIGC 的外部入口为 `https://aigcbackend.boschhuayu-steering.com`，域名指向 nj304 (`172.28.2.33`)；不要将 LiteLLM 地址改成 nj304。

   如果 AIGC 改用 LiteLLM HTTPS 域名，`LiteLlm__VerifySsl` 默认是 `"true"`，要求 API 容器信任完整证书链。仅在排查企业 CA 或中间证书链问题时可暂时设为 `"false"`；它只影响 AIGC 到 LiteLLM 的请求（模型同步、Key 管理、聊天），不影响 DSH 客户端自身的 HTTPS 校验。修复证书链后应恢复为 `"true"` 并重启 API。
4. 使用下述离线镜像包，将四个镜像导入 nj304 的 containerd `k8s.io` 命名空间。四个 Deployment 已设置镜像 Tag `2026-09-28.2`，固定在 nj304 且使用 `imagePullPolicy: Never`，不会向 Docker Hub 拉取。以后重新打包新 Tag 时，同步修改四个 Deployment 的 Tag。
5. 已在 nj304 本机执行 `sudo ss -lntp '( sport = :80 or sport = :443 )'`，当时 80/443 没有监听进程。应用边缘入口前再确认一次端口状态及集群是否允许 `hostNetwork`。
6. `ssl/aigcbackend.boschhuayu-steering.com.crt` 与 `.key` 已校验配对，证书 SAN 覆盖域名，有效期至 2028-09-21。`.crt` 仅含一张证书；客户端还必须信任签发它的企业 CA。如需完整证书链，先取得并合并 CA 链，不要用 `.pfx` 直接替代 Nginx 所需的 PEM 文件。不要提交证书私钥、生产密钥或填写后的 Secret 文件。

## 首次启动的用户

空数据库启动后，当前 API 代码会自动创建三个示例用户：`wh00028`（平台管理员）、`wh00136`（流程管理员）、`wh00412`（普通用户）。初始密码均为 `Bhss@123`，代码中固定；生产首次登录后**立即修改密码**，并禁用或删除不需要的示例用户。若数据库 `Users` 表已有任何用户，启动逻辑不会再次创建这三个账号。

## 本机制作离线镜像包（Windows PowerShell）

在仓库根目录执行，确保 Docker Desktop 运行 Linux 容器并且本机能获取 .NET、Node、Nginx 基础镜像：

```powershell
./deploy/k8s/bosch-aigc-dsh/package-offline-images.ps1 -Tag 2026-09-28.2
```

脚本使用现有 `server/AigcHub.Api/Dockerfile` 和 `portal/Dockerfile` 构建 `linux/amd64` 服务镜像，并把本机已有的 `nginx:1.27-alpine`、`postgres:17-alpine` 一同以**单平台**格式导出到 `artifacts/aigc-dsh-images-<Tag>-linux-amd64.tar`，同时输出 SHA256。Portal 的 API URL 是**构建期**变量，已固定为 `https://aigcbackend.boschhuayu-steering.com`；仅修改 K8s 环境变量不能改变已构建前端的地址。原 `aigc-dsh-images-2026-09-28.2.tar` 的 OCI 多平台索引引用了未打入包内的摘要，`ctr import` 会失败，**不要使用**。修复包为 `aigc-dsh-images-2026-09-28.2-linux-amd64.tar`，大小 298185728 字节，SHA256：`89567F27879D1EE900EB4AD83925221229E41348166B4EFCF53B76FEC1132A2E`；已检查 122 个内容摘要引用，均在包内。

将 tar 复制到 nj304 后，在该节点执行：

```bash
sha256sum aigc-dsh-images-2026-09-28.2-linux-amd64.tar
sudo ctr -n k8s.io images import aigc-dsh-images-2026-09-28.2-linux-amd64.tar
sudo ctr -n k8s.io images ls | grep -E 'aigc-(api|portal|edge-nginx|postgres):2026-09-28.2'
```

如需使用私有仓库而不是离线导入，另有 `build-images.ps1`，但需同步修改 Deployment 的镜像名和拉取策略。

## 上传后的执行顺序

以下命令假设部署目录位于 master 的 `~/aigc-deploy/deploy/k8s/bosch-aigc-dsh`，离线 tar 已单独上传到 nj304。不要把 `ssl/*.key` 或填写后的 Secret 上传到公开下载目录。

### 1. nj304：准备空目录并导入镜像

先运行 `df -hT` 选择有足够空间、重启后仍保留数据的挂载盘。下面的 `/data/bosch-aigc-dsh` **只是示例**，必须与稍后 PV 模板中的路径一致：

```bash
sudo mkdir -p /data/bosch-aigc-dsh/{postgres,data-protection,uploads}
sha256sum aigc-dsh-images-2026-09-28.2-linux-amd64.tar
sudo ctr -n k8s.io images import aigc-dsh-images-2026-09-28.2-linux-amd64.tar
sudo ctr -n k8s.io images ls | grep -E 'aigc-(api|portal|edge-nginx|postgres):2026-09-28.2'
sudo ss -lntp '( sport = :80 or sport = :443 )'
```

SHA256 应为 `89567F27879D1EE900EB4AD83925221229E41348166B4EFCF53B76FEC1132A2E`；不一致就停止。最后一条命令应没有监听记录，否则不要启用边缘 Nginx。

### 2. master：创建 namespace、静态 PV 和 PVC

```bash
cd ~/aigc-deploy
kubectl apply -f deploy/k8s/bosch-aigc-dsh/namespace.yaml
cp deploy/k8s/bosch-aigc-dsh/pv-local.example.yaml /tmp/bosch-aigc-dsh-pv.yaml
# 编辑 /tmp/bosch-aigc-dsh-pv.yaml，把三处 REPLACE_STORAGE_ROOT 改成 nj304 实际目录的共同父目录
kubectl apply -f /tmp/bosch-aigc-dsh-pv.yaml
kubectl -n bosch-aigc-dsh apply -f deploy/k8s/bosch-aigc-dsh/storage.yaml
kubectl -n bosch-aigc-dsh get pvc
```

三个 PVC 都显示 `Bound` 后继续。如果 `Pending`，先检查 PV 路径、容量、nodeAffinity 和事件，不要跳过。

### 3. master：填写 Secret 并导入证书

```bash
umask 077
cp deploy/k8s/bosch-aigc-dsh/secret.example.yaml /tmp/aigc-secrets.yaml
# 编辑 /tmp/aigc-secrets.yaml：替换所有 REPLACE_ 值；POSTGRES_PASSWORD 与连接字符串 Password 必须完全一致
kubectl apply -f /tmp/aigc-secrets.yaml
kubectl -n bosch-aigc-dsh create secret tls aigc-edge-tls --cert=deploy/k8s/bosch-aigc-dsh/ssl/aigcbackend.boschhuayu-steering.com.crt --key=deploy/k8s/bosch-aigc-dsh/ssl/aigcbackend.boschhuayu-steering.com.key
```

### 4. master：启动数据库、API 和前端

```bash
kubectl kustomize deploy/k8s/bosch-aigc-dsh >/dev/null
kubectl apply -k deploy/k8s/bosch-aigc-dsh
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-postgres --timeout=180s
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=180s
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-portal --timeout=180s
kubectl -n bosch-aigc-dsh get pods,svc,pvc -o wide
```

### 5. master：启动 HTTPS 入口并验证

```bash
kubectl apply -f deploy/k8s/bosch-aigc-dsh/edge-config.yaml
kubectl apply -f deploy/k8s/bosch-aigc-dsh/edge-hostnetwork.yaml
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-edge --timeout=180s
curl -v --resolve aigcbackend.boschhuayu-steering.com:443:172.28.2.33 https://aigcbackend.boschhuayu-steering.com/health
```

如果 master 尚未信任企业 CA，最后的 `curl` 可能因证书链失败；这不等于应在生产客户端关闭验证。`/health` 只检查 API 进程响应，**不验证 PostgreSQL/LiteLLM 连通性**。上线前还要手工验证登录、模型列表、聊天、上传和 CAS 回调。Nginx 将 `/api`、`/v1`、`/health`、`/swagger` 转给 API，其余路径转给 Portal。该入口直接占用 nj304 的 80/443，不会创建 Ingress。
