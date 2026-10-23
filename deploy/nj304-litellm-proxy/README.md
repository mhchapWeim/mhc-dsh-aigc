# nj304 离线反向代理部署

> 本文为历史初装说明。当前新域名 30443 的 ASR 增量部署及代理维护规则见 [内网 DMZ 代理服务说明](../../docs/INTRANET-DMZ-PROXY.md)。已有集群不要直接 apply 本目录旧模板覆盖双域名配置。

## 已准备

Nginx 1.30.4 linux/amd64 镜像、nginx-image.tar、image-ref.txt、SHA256SUMS、proxy.yaml、deploy.sh、已准备；入口证书直接复用现有 TLS Secret aigc-edge-tls，不在包中携带私钥。
入口：https://aigcbackend.boschhuayu-steering.com:30443/v1
上游：https://litellm.boschhuayu-steering.com（192.168.10.30）
节点：bosch-k8s-node-nj304（172.28.2.33）
命名空间：bosch-aigc-dsh

按用户要求，proxy_ssl_verify off：上游仍使用 HTTPS，但不验证证书身份。无需 ca-bundle.pem。客户端到 nj304 的 HTTPS 校验保留，客户端需信任公司 CA。现有 Secret 的证书域名已核对；客户端仍需信任公司 CA。

直接挂载 bosch-aigc-dsh/aigc-edge-tls；不创建、覆盖或删除该共享 Secret。

## nj304 导入镜像

解压上传包，执行：

```bash
sha256sum -c SHA256SUMS
sudo ctr -n k8s.io images import --platform linux/amd64 nginx-image.tar
sudo ctr -n k8s.io images ls | grep nginx
```

使用 kubelet 实际连接的 containerd，默认命令使用系统 socket。image-ref.txt 使用 docker.io/library/nginx:1.30.4-nj304。

## master 部署

上传并解压同一个包，进入目录执行：

```bash
sed -i 's/\r$//' deploy.sh
kubectl get svc -A -o wide
bash deploy.sh
```

确认 30443 未被其他 Service 占用。脚本仅部署代理，不自动切换 AIGC。副本为 1，固定 nj304，imagePullPolicy: Never。

部署使用 proxy.yaml 中的 ConfigMap；default.conf 是相同内容的本地验证副本。修改配置以 proxy.yaml 为准。

## 客户端验证

从 DSH 所在网络执行（Windows 用 curl.exe）：

```bash
curl https://aigcbackend.boschhuayu-steering.com:30443/healthz
```

应返回 ok。修改 chat-test.json 中 model 为用户获授权的模型名，再执行 Bash 命令：

```bash
read -rsp 'User Virtual Key: ' USER_VIRTUAL_KEY
printf '\n'
curl -N https://aigcbackend.boschhuayu-steering.com:30443/v1/chat/completions -H "Authorization: Bearer ${USER_VIRTUAL_KEY}" -H 'Content-Type: application/json' --data-binary @chat-test.json
unset USER_VIRTUAL_KEY
```

应增量返回 SSE，最后为 [DONE]。客户端必须信任入口证书，不用 -k 做验收。还需验证取消请求及长响应。healthz 不证明上游可达。

## 切换 AIGC

```bash
kubectl -n bosch-aigc-dsh get deployments
kubectl -n bosch-aigc-dsh set env deployment/实际后端Deployment名称 LiteLlm__PublicBaseUrl=https://aigcbackend.boschhuayu-steering.com:30443/v1
kubectl -n bosch-aigc-dsh rollout status deployment/实际后端Deployment名称 --timeout=180s
```

set env 会自动触发滚动更新。环境变量名沿用之前实现记录，执行前核对部署应用。若由 Helm/GitOps 管理，同步更新配置源。保留内部 BaseUrl 和 ManagementApiKey。重新登录 DSH。

## 故障排查

```bash
kubectl -n bosch-aigc-dsh logs deployment/nj304-litellm-proxy --tail=100
kubectl -n bosch-aigc-dsh describe pods -l app=nj304-litellm-proxy
```

客户端需能访问 172.28.2.33:30443。实际 Pod 需能解析 LiteLLM 域名并连接 192.168.10.30:443；节点连通不代表 Pod 连通。502/504 检查 Pod 出口和上游日志；401/403 检查 Key 和模型权限。

只开放 /v1/chat/completions。其他协议如 /v1/messages、/v1/responses 需要显式增加规则。浏览器跨域访问需另配置精确来源的 CORS。

配置变更后：

```bash
kubectl apply -f proxy-rendered.yaml
kubectl -n bosch-aigc-dsh rollout restart deployment/nj304-litellm-proxy
kubectl -n bosch-aigc-dsh rollout status deployment/nj304-litellm-proxy --timeout=180s
```

修改 proxy.yaml 后应重新运行 bash deploy.sh，以重新生成 proxy-rendered.yaml。

## 回退

恢复 AIGC 原 PublicBaseUrl 并刷新 DSH 登录（原直连仍受公司网络限制）。若需要删除本包资源：

```bash
kubectl delete -f proxy.yaml
```

不要删除共享命名空间。LiteLLM 服务器原 Nginx 无需修改。

## 验证状态

入口证书域名和私钥匹配，有效期 2026-09-22 至 2028-09-21。已用实际镜像和本机匹配证书通过 nginx -t；复用 Secret 的公开证书域名和有效期已确认。未在 Kubernetes 集群执行部署或验证上游连通性。
镜像已修正为显式 linux/amd64 导出，并检查索引引用的 manifest、config 和 layer 文件均存在。服务器导入仍需实际验证。
