# DMZ 服务器现场记录

后续涉及 DMZ Nginx、博查出网、百炼 WebSocket 或内网到 DMZ 转发时，先读取本文及 `docs/INTRANET-DMZ-PROXY.md`，再检查现场实际配置。

记录日期：2026-10-22。依据：用户提供的 DMZ Docker / Nginx 检查输出。本文是现场快照，后续操作前需复核；不代表 ASR 已部署。

## 主机与服务

| 项目 | 已知信息 |
| --- | --- |
| DMZ IP | `192.168.10.30`（用户提供的拓扑） |
| 对外服务域名 / Nginx server_name | `litellm.boschhuayu-steering.com` |
| Nginx 容器 | `litellm-gateway` |
| Nginx 版本 | `1.31.6` |
| Docker 网络模式 | `host` |
| Nginx 监听 | `443 ssl` |
| LiteLLM 上游 | `http://127.0.0.1:4000` |
| DNS | `127.0.0.53`，宿主 DNS stub |
| 当前配置校验 | 用户提供的 `nginx -t` 输出为成功 |
| 百炼域名可达 | 用户说明 DMZ 可以访问；本轮未执行实际 WebSocket / ASR 验证 |

SSH 地址、SSH 用户、操作系统版本、Compose 文件路径、Docker 镜像标签及服务重建命令未收集，不能仅凭宿主目录名推断。

## 已确认的 bind mounts

全部显示 `rw=false`，即容器内只读；宿主机修改文件后仍需检查容器是否看到新内容。

| 宿主路径 | 容器路径 | 用途 |
| --- | --- | --- |
| `/home/admnj00663/litellm/nginx.conf` | `/etc/nginx/nginx.conf` | 完整 Nginx 主配置，单文件 bind mount |
| `/home/admnj00663/litellm/litellm.boschhuayu-steering.com` | `/etc/nginx/tls` | HTTPS 证书及私钥目录 |
| `/etc/ssl/certs/ca-certificates.crt` | `/etc/ssl/certs/ca-certificates.crt` | 上游公共 CA 信任包，已确认可读 |

配置中的证书路径：

```nginx
ssl_certificate /etc/nginx/tls/litellm.boschhuayu-steering.com.crt;
ssl_certificate_key /etc/nginx/tls/litellm.boschhuayu-steering.com.key;
```

不得将私钥、API Key 或完整敏感配置复制到文档或日志。

## 当前已确认路由

以下来自用户提供的配置摘要，完整指令仍需现场核实。

| DMZ 路径 | 行为 / 上游 |
| --- | --- |
| 精确 `/__aigc/bocha-search` | 转发到 `https://$bocha_upstream/v1/web-search`，SNI 为 `api.bochaai.com` |
| 精确 `/__aigc/deepseek-search` | 路由存在；摘要未包含返回指令。仓库模板为返回 404，现场行为未核实 |
| `/` | 转发到 `http://127.0.0.1:4000` |

博查配置摘要已确认：

```nginx
resolver 127.0.0.53 valid=30s ipv6=off;
resolver_timeout 5s;
proxy_ssl_name api.bochaai.com;
proxy_ssl_verify on;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
```

用户输出没有包含博查 allow/deny 的具体值，也未提供真实博查请求结果。仓库模板白名单为 `172.28.2.33`，不能据此当成现场已确认值。ASR 自动部署脚本直接读取并继承现场博查 allow/deny，无法识别时停止。

## 与内网服务的关系

博查仓库定义的调用链：

```text
DSH → AIGC API /v1/plugins/search
    → DMZ https://litellm.boschhuayu-steering.com/__aigc/bocha-search
    → 博查 https://api.bochaai.com/v1/web-search
```

博查由 AIGC API 服务端访问 DMZ，不是 DSH 直连，也没有经过 nj304 的 30443 转发 Pod。此链路依据仓库代码和部署配置，尚未通过本轮线上请求追踪确认。

内网通用入口是固定路径反向代理：

```text
aigcplatform.boschhuayu-steering.com:30443
 → Kubernetes nj304-litellm-proxy
 → DMZ 192.168.10.30:443
```

nj304 代理在命名空间 `bosch-aigc-dsh`，历史模板只开放 `/v1/chat/completions`。它与本机 `litellm-gateway` 是两个独立的 Nginx 服务。新增跨区域路由需要逐跳检查。

## ASR 计划与交付状态

目标上游：

```text
wss://ws-ho4ojmbqyhvmtbay.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
```

模型：`qwen-audio-3.0-asr-flash-streaming`。计划两侧新增精确路径 `/api-ws/v1/inference`，客户端最终访问：

```text
wss://aigcplatform.boschhuayu-steering.com:30443/api-ws/v1/inference
```

- nj304 → DMZ：按用户要求关闭上游证书校验，保留 HTTPS 和 Host/SNI；不需要新增 DMZ CA 挂载。
- DMZ → 百炼：保留公共 CA 证书校验。
- 两侧使用 HTTP/1.1、Upgrade / Connection，透明传递握手 Authorization 和音频帧。
- 不在 Nginx 中保存百炼 API Key；客户端或未来授权中继负责提供凭据。
- DMZ 脚本：`deploy/nj304-litellm-proxy/asr/deploy-dmz-asr.sh`。
- 完整部署、验证、回退：`docs/INTRANET-DMZ-PROXY.md`。
- 已完成本地 Bash 语法、配置插入/保留、白名单继承和重复路由拦截检查。尚无用户反馈证明脚本已执行成功，不能标记为生产已部署；尚未真实 ASR 验收。

## 后续操作方法

先只读复核挂载、网络和当前配置校验：

```bash
docker inspect litellm-gateway --format '{{json .Mounts}}'
docker inspect litellm-gateway --format '{{.HostConfig.NetworkMode}}'
docker exec litellm-gateway nginx -v
docker exec litellm-gateway nginx -t
```

修改前备份实际宿主配置，增量修改目标 server，保留博查、LiteLLM 和 TLS 指令。单文件 bind mount 应原位写入以保留 inode；编辑器原子替换文件可能使容器继续读到旧文件。修改后必须核对容器实际内容，`nginx -t` 成功后再 reload：

```bash
docker exec litellm-gateway nginx -t
docker exec litellm-gateway nginx -s reload
```

优先 reload，无需为新增路由重启容器。不要直接用仓库 `deploy/deepseek-search-proxy/nginx.conf` 整体覆盖现场：现场证书文件名与模板不同，而且可能存在其他配置差异。恢复也要原位写入，并校验后 reload；期间若有其他变更，先人工合并。

日志可通过以下命令检查；是否包含访问日志取决于现场 logging 配置，分享前排除敏感内容：

```bash
docker logs --tail 100 litellm-gateway
```

配置成功、reload 成功、DNS/443 可达都不能替代真实 WebSocket 握手和识别结果验收。部署结果有新证据后，应更新本文状态及 `DEPLOYMENT-RUNBOOK.md`。
