# 内网到 DMZ 的代理服务与 ASR 部署

DMZ 主机的现场信息统一记录在 [DMZ-SERVER.md](DMZ-SERVER.md)，操作前先读取并复核。

后续涉及内网访问外部服务、30443、DMZ 转发或 WebSocket 时，先读取本文，再检查线上配置。本文记录 2026-10-22 的仓库依据和部署方案，不代表已完成线上部署。

## 拓扑与边界

```text
内网客户端 → aigcplatform.boschhuayu-steering.com:30443
           → nj304-litellm-proxy（Kubernetes Nginx，8443）
           → 192.168.10.30:443（DMZ Nginx，litellm.boschhuayu-steering.com）
           → 固定的外部服务
```

- 集群命名空间：`bosch-aigc-dsh`；Deployment / ConfigMap / Service：`nj304-litellm-proxy`。
- NodePort：30443；节点：`bosch-k8s-node-nj304`，172.28.2.33；以现场资源为准。
- 新入口域名为 `aigcplatform.boschhuayu-steering.com`。历史域名 `aigcbackend.boschhuayu-steering.com` 可能仍有兼容 SNI server，不要用旧模板覆盖现场配置。
- 内网到 DMZ：HTTPS，按用户要求 `proxy_ssl_verify off`，无需额外挂载 DMZ CA；仍发送正确 Host / SNI。客户端仍需信任入口公司证书。
- DMZ 到百炼：HTTPS，开启证书校验，使用系统公共 CA。
- 这是固定目标、固定路径的反向代理，不是任意 URL 的通用出网代理。每项新服务都应配置明确的路径、上游、鉴权和来源范围。

现有聊天路径 `/v1/chat/completions` 由 DMZ 转给 LiteLLM；博查 `/__aigc/bocha-search` 在 DMZ 转给博查，但仓库 AIGC 配置是直接访问 DMZ 域名，不能假定它已经经过 30443。ASR 新增路径见下文。

配置来源：`deploy/nj304-litellm-proxy/proxy.yaml` 是历史初装模板；`default.conf` 是对应副本。后续域名切换由 `deploy/k8s/bosch-aigc-dsh/domain-switch-2026-10-15/prepare.py` 基于线上配置生成双域名配置。已有部署更新必须从现场 ConfigMap 生成补丁，不能重新 apply 历史初装模板。

## ASR 路由和客户端

```text
wss://aigcplatform.boschhuayu-steering.com:30443/api-ws/v1/inference
 → DMZ /api-ws/v1/inference
 → wss://ws-ho4ojmbqyhvmtbay.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
```

模型：`qwen-audio-3.0-asr-flash-streaming`。客户端握手携带 `Authorization: Bearer <API Key>`，两层透明转发；模型写在客户端 `run-task` 消息中，Nginx 不改协议或模型。API Key 不写入本仓库、命令行或 Nginx 配置。

本方案适用于能设置 WebSocket 请求头的桌面/服务端客户端。若浏览器直接使用，或需要 AIGC 用户授权、隐藏共享 Key，需要额外的服务端 WebSocket 中继；当前透明代理不提供这些功能。来源白名单只是网络访问限制。

两侧专用 location 都使用 HTTP/1.1 和 Upgrade/Connection，并关闭缓冲。3600 秒是读写空闲超时，不是百炼任务时长保证。客户端按服务协议管理音频输入、心跳、结束和重连；代理不自动重放音频。

## 部署前准备

将 `deploy/nj304-litellm-proxy/asr/` 目录传到控制节点和 DMZ 主机。以下命令在 Linux Bash 执行，使用 `set -euo pipefail`，遇错停止。无镜像构建、无数据库修改。建议先完成 DMZ，再更新内网代理。

DMZ 确认：真实 Nginx 容器名、配置 bind mount 路径、到百炼域名的 DNS/443、CA 文件，以及 DMZ 实际看到的内网代理出口 IP。`dmz.location.conf` 默认白名单为 172.28.2.33，默认 DNS 为 host 网络下的 127.0.0.53；网络方式不同时必须按现场修改。

## 一、DMZ 主机部署

### 已确认现场的直接部署方式（推荐）

2026-10-22 用户提供的现场输出确认：容器 `litellm-gateway`，Nginx 1.31.6，host 网络；宿主 `/home/admnj00663/litellm/nginx.conf` 以只读单文件 bind mount 挂到 `/etc/nginx/nginx.conf`。TLS 目录来自 `/home/admnj00663/litellm/litellm.boschhuayu-steering.com`；公共 CA 文件已挂载且可读；DNS 为 127.0.0.53；现有配置校验成功。百炼网络可达由用户说明，尚未通过本次真实 ASR 请求验证。

将单个文件 `deploy/nj304-litellm-proxy/asr/deploy-dmz-asr.sh` 上传 DMZ，进入文件所在目录执行：

```bash
# 先做候选配置检查，不修改当前 nginx.conf，也不 reload。
sudo env CHECK_ONLY=1 bash deploy-dmz-asr.sh
# 检查通过后执行实际更新。
sudo bash deploy-dmz-asr.sh
```

脚本需要宿主 Python 3、flock、Docker；无需安装新服务或提供 API Key。脚本核对容器挂载和 host 网络，自动找到目标 server 中的博查路由，继承其中的 allow/deny 来源限制（无法识别则停止），插入 ASR location。先在现有容器里校验完整候选配置，再备份并原位写入，检查容器实际内容一致后校验和 reload；失败自动恢复备份并尝试 reload。不会覆盖整个现有配置模板，不会重启容器。重复执行检测到现有 ASR 路由会停止。

注意：这里 DMZ → 百炼仍开启证书校验；关闭的是另一侧的 nj304 → DMZ 校验。部署完成只代表配置生效，后续仍需部署 nj304 路由并进行真实 ASR 验收。Nginx reload 命令成功不等于真实识别成功。

脚本输出实际备份路径。需要手动回退时，将下面路径替换成该输出（期间有其他配置改动时先人工合并）：

```bash
sudo bash -euo pipefail -c '
cat /home/admnj00663/litellm/nginx.conf.before-asr-实际时间戳及PID > /home/admnj00663/litellm/nginx.conf
docker exec litellm-gateway nginx -t
docker exec litellm-gateway nginx -s reload
'
```

### 其他环境的手动操作参考

进入上传的 `asr` 目录：

```bash
set -euo pipefail
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
read -r -p '实际 Nginx 容器名: ' NGINX_CONTAINER
docker inspect "$NGINX_CONTAINER" --format '{{json .Mounts}}'
docker inspect "$NGINX_CONTAINER" --format '{{.HostConfig.NetworkMode}}'
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" sh -c 'test -r /etc/ssl/certs/ca-certificates.crt'
read -r -p '实际宿主机 Nginx 配置文件绝对路径: ' DMZ_CONF
test -f "$DMZ_CONF"
DMZ_BACKUP="${DMZ_CONF}.before-asr-$(date +%Y%m%d-%H%M%S)"
sudo cp -p -- "$DMZ_CONF" "$DMZ_BACKUP"
printf '回退文件: %s\n' "$DMZ_BACKUP"
cat dmz.location.conf
sudoedit "$DMZ_CONF"
```

在编辑器中，将 `dmz.location.conf` 的完整 location 加入 `server_name litellm.boschhuayu-steering.com` 对应的 HTTPS server 内。核对出口白名单和 DNS。保留博查、LiteLLM 及现有 TLS 配置；不要整体覆盖配置。若已有相同路径，先核对，不能重复添加。

```bash
# 先确认容器实际看到新增路由；不要使用会输出所有配置/凭据的 nginx -T。
docker exec "$NGINX_CONTAINER" nginx -t
# 单文件 bind mount 经编辑器替换后可能仍指向旧 inode。
# 用 docker inspect 确认容器内配置路径，再检查该文件是否包含 ASR 路径。
read -r -p '上面宿主配置对应的容器内绝对路径: ' DMZ_CONTAINER_CONF
docker exec "$NGINX_CONTAINER" grep -F 'location = /api-ws/v1/inference' "$DMZ_CONTAINER_CONF"
docker exec "$NGINX_CONTAINER" nginx -s reload
```

若 grep 未找到，停止；用原有 Compose 配置重建该 Nginx 服务后重新检查，不要 reload 旧配置冒充生效。本步骤只是新增 location，正式 ASR 验收见后文。

## 二、Kubernetes 控制节点部署

进入上传的 `asr` 目录，需 Python 3 和 kubectl。先核对 context：

```bash
set -euo pipefail
kubectl config current-context
kubectl -n bosch-aigc-dsh get svc nj304-litellm-proxy -o wide
kubectl -n bosch-aigc-dsh get deploy nj304-litellm-proxy -o wide
WORK="asr-$(date +%Y%m%d-%H%M%S)"
mkdir "$WORK"
kubectl -n bosch-aigc-dsh get cm nj304-litellm-proxy -o json > "$WORK/configmap.before.json"
python3 prepare.py "$WORK/configmap.before.json" "$WORK/prepared"
diff -u <(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["default.conf"],end="")' "$WORK/configmap.before.json") "$WORK/prepared/default.conf" || test "$?" -eq 1

# 用现有 Pod 的证书挂载和 Nginx 二进制校验候选配置。
kubectl -n bosch-aigc-dsh exec -i deployment/nj304-litellm-proxy -c nginx -- sh -c 'cat > /tmp/asr-check.conf; nginx -t -c /tmp/asr-check.conf' < "$WORK/prepared/check.conf"

# JSON test 操作防止覆盖快照后发生的并发配置变更。
kubectl -n bosch-aigc-dsh patch cm nj304-litellm-proxy --type=json --patch-file "$WORK/prepared/apply.json"
kubectl -n bosch-aigc-dsh rollout restart deployment/nj304-litellm-proxy
kubectl -n bosch-aigc-dsh rollout status deployment/nj304-litellm-proxy --timeout=180s
kubectl -n bosch-aigc-dsh exec deployment/nj304-litellm-proxy -c nginx -- nginx -t
printf '保存回退目录: %s\n' "$WORK"
```

脚本向现有每个带 `/healthz` 的 SNI server 插入 ASR location，保留所有原始配置；若结构不同或已经存在 ASR 路由会停止，需检查现场。只修改 ConfigMap 的 `default.conf` 并重启代理 Deployment。单副本重启会中断现有长连接，应安排窗口。

## 三、验证

在内网客户端执行（使用系统信任的公司 CA；不要用 `-k` 做验收）：

```bash
curl --fail --show-error https://aigcplatform.boschhuayu-steering.com:30443/healthz
```

返回 ok 只证明入口正常。客户端配置为：

```yaml
asr_model: qwen-audio-3.0-asr-flash-streaming
asr_url: wss://aigcplatform.boschhuayu-steering.com:30443/api-ws/v1/inference
asr_api_key: <从安全配置读取>
```

使用真实 ASR 客户端验证握手 101、run-task → task-started、发送符合参数的音频 → result-generated、finish-task → task-finished；验证预期时长的录音、主动取消和重连。检查两侧日志时间关联，禁止记录 Authorization 或 Key。代理成功不代表模型可用/音频格式正确，需要真实识别结果验收。

排查：404 检查两侧路由和 SNI；400/426 检查 Upgrade；403 检查 DMZ 来源白名单和上游错误；401 检查百炼凭据；502/504 检查每一跳的 DNS、网络、TLS 和超时。TCP 连通或 healthz 不能替代 WebSocket 验证。

## 回退

控制节点同一 Bash 会话（或将 WORK 设置成上面保存的实际目录）：

```bash
kubectl -n bosch-aigc-dsh patch cm nj304-litellm-proxy --type=json --patch-file "$WORK/prepared/restore.json"
kubectl -n bosch-aigc-dsh rollout restart deployment/nj304-litellm-proxy
kubectl -n bosch-aigc-dsh rollout status deployment/nj304-litellm-proxy --timeout=180s
```

如果 test 操作失败，说明部署后还有其他配置变更，先人工比对，不要整体覆盖。`rollout undo` 不会恢复 ConfigMap。

DMZ 同一会话中恢复备份，保留目标文件 inode，再校验并 reload：

```bash
sudo sh -c 'cat "$1" > "$2"' sh "$DMZ_BACKUP" "$DMZ_CONF"
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
```

若期间有其他配置改动，只移除本次新增的 ASR location；单文件 bind mount 仍需检查容器是否看到恢复内容。

## 后续需求处理规则

先读本文和线上 ConfigMap / DMZ 挂载配置，确认 HTTP、SSE 或 WebSocket；明确固定上游和路径、Host/SNI、凭据归属、来源 IP、CA 和空闲超时。WebSocket 必须逐跳配置 Upgrade，不能复用聊天路由的 `Connection ""`。保留现有域名证书、路由和 Secret，从快照生成小范围补丁，校验、备份、部署、业务验收、回退。部署后把实际结果补充到 runbook，不能把本地检查写成生产成功。

协议参考：https://help.aliyun.com/en/model-studio/realtime-websocket-overview

## 本地验证记录

2026-10-22：补丁生成器已通过单 SNI / 双 SNI 配置保留、回退内容及重复添加拦截检查。本机 Docker 引擎不可用，未完成 Nginx 语法或 WebSocket 实际连接验证；部署命令包含在现有 Pod 内执行候选配置 nginx -t 的步骤。没有执行生产修改。

DMZ 自动脚本另通过 Bash 语法检查、ASR 插入后原配置保留、博查白名单继承、重复路由拦截和开放白名单拦截检查。尚未在真实 Docker 容器中运行该脚本或验证失败恢复流程。
