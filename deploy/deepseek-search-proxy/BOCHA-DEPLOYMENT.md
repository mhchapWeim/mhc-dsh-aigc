# 博查搜索：AIGC 直达远端 Nginx

链路：DSH → AIGC API（插件授权、密钥解密）→ LiteLLM 服务器上的 Nginx → 博查。
不修改 nj304-litellm-proxy，也不需要重新打包 DSH 或插件。需要构建并部署包含本次代码的 AIGC API 镜像；旧镜像不识别下面的新配置。

## 1. LiteLLM Docker 主机

先用 `docker ps` 确认 Nginx 容器名，通过 `docker inspect <容器名>` 确认实际配置挂载路径。
将本目录 nginx.conf 中新增的 `location = /__aigc/bocha-search` 合并到实际配置的对应 server 中，保留现场其他配置。先备份实际挂载文件，不要直接覆盖未知的现场配置。

新增路径只允许 POST，来源白名单为 172.28.2.33。确认远端实际看到的 AIGC 出口地址；若不同，仅调整为实际出口地址，不删除白名单。
Nginx 容器必须能解析 api.bochaai.com 并连接其 443，且存在 `/etc/ssl/certs/ca-certificates.crt`。
若宿主机能出网、容器不能出网，先修复容器网络。该配置使用直接 HTTPS 上游，不会自动使用企业 HTTP CONNECT 代理。

以下 Bash 命令将实际容器名填入变量后执行：

```bash
read -r -p 'Nginx container name: ' NGINX_CONTAINER
docker exec "$NGINX_CONTAINER" nginx -t
# 仅在 nginx -t 成功后执行
docker exec "$NGINX_CONTAINER" nginx -s reload
```

如果配置文件是单文件 bind mount，替换宿主文件后必须确认容器内看到的是新配置；必要时使用原有 Docker Compose 方式重建 Nginx 容器。

## 2. AIGC 配置与镜像

按 DEPLOYMENT-RUNBOOK.md 构建、导入并部署新的版本化 API 镜像。不要重用此前的旧镜像标签。Portal 无需更新。
不要整体覆盖线上 aigc-settings；以下命令只合并博查配置。

Kubernetes 控制节点 Bash：

```bash
kubectl -n bosch-aigc-dsh get cm aigc-settings -o yaml > aigc-settings.before-bocha.yaml
kubectl -n bosch-aigc-dsh get deploy aigc-api -o yaml > aigc-api.before-bocha.yaml
kubectl -n bosch-aigc-dsh patch cm aigc-settings --type merge -p '{"data":{"BochaSearch__Endpoint":"https://litellm.boschhuayu-steering.com/__aigc/bocha-search","BochaSearch__VerifySsl":"true"}}'
kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-api
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=180s
```

执行前确认实际 Deployment 名称及 envFrom 是否读取 aigc-settings；显式同名 env 会覆盖 ConfigMap，应同步处理。
BochaSearch__VerifySsl 默认 true，独立于 LiteLlm__VerifySsl。企业 CA 应加入 API 容器信任链；不要因现有 LiteLLM 配置关闭校验而假定博查代理自动关闭校验。
临时诊断如确需关闭，仅设置 BochaSearch__VerifySsl=false，并在补齐信任链后恢复。
Endpoint 必须是 HTTPS 完整地址，不允许用户名密码、查询参数或片段。未配置时保持原有博查直连地址；不会在代理失败时自动回退外网。

## 3. 验证

在已有博查插件发布、启用并授权的 DSH 中执行一次网页搜索。
按时间关联 AIGC `/v1/plugins/search` 请求和远端 Nginx `POST /__aigc/bocha-search` access log，确认返回成功且 DSH 收到来源信息。
不要把博查 Key 或用户令牌写入命令、日志或截图。

- 远端 403：检查实际出口 IP 与来源白名单。
- AIGC 502 且远端无请求：检查 DNS、路由、证书信任及现场配置覆盖。
- 远端 502/504：检查 Nginx 容器到博查的 DNS、443、CA 及超时。
- 博查 401/403：检查 AIGC 插件管理中的博查 Key。
- AIGC 429：检查博查额度或限流。

## 4. 回滚

恢复部署前记录的 API 镜像和原有 BochaSearch 配置，再重启 API。若此前不存在这两个配置，可移除：

```bash
kubectl -n bosch-aigc-dsh patch cm aigc-settings --type merge -p '{"data":{"BochaSearch__Endpoint":null,"BochaSearch__VerifySsl":null}}'
kubectl -n bosch-aigc-dsh rollout restart deployment/aigc-api
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=180s
```

远端恢复配置备份，nginx -t 成功后 reload。不涉及数据库或数据卷修改。回滚后 nj304 仍无法直连博查，搜索不会因此恢复可用。

## 本地验证状态

PluginMarketHttpTests 5 项通过，包括默认直连及自定义代理地址、授权撤销和密钥不下发。
未执行生产部署、远端联网测试或 Nginx 语法检查；本地 Docker daemon 未运行。
