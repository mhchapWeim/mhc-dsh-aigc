# 应用网关现场接入与回滚

本文只说明 nj304 上 `aigcplatform-steering.com` 的接入顺序。它不是生产变更授权。未取得当次部署许可前，不要修改 DNS、证书、nginx、网关 Deployment 或数据库。

## 已经在本地验证的部分

- 发布申请忽略客户端传入的流程编码，使用 `publication -> application-publishing` 绑定，并保存当时的 `ProcessDefinitionId`。
- 发布新版本后，在途实例仍指向原版本，新申请使用新版本。
- 删除绑定后提交被拒绝，不会新增申请记录。
- 访问申请在并发下只保留一张在途单；审批通过写一次个人授权；重复完成任务返回冲突，不会再次授权。
- 审批时路由已失效，流程记为失败且不授权。
- 普通目录接口不返回源站地址。启动接口只返回一次性票据、slug 和网关公开源。撤销个人授权后，目录和启动接口都不再放行该应用。
- 票据过期或重放不能兑换。合法兑换返回 303，并设置 host-only 的 HttpOnly 会话 Cookie。
- 空闲超时大于会话最长时长时保存被拒绝。已建立会话的绝对到期时间不随新配置改变。
- 网关项目 `server/AigcHub.Gateway` 可以单独编译。它只注册网关所需服务，不启动 API 的 MQ 和其他后台任务。

这些结论来自 `dotnet test` 中的 `ApplicationGatewayHttpTests`，使用内存数据库和替身连通性探针。没有对 nj304、真实上游或公网证书执行操作。

## 仍需现场确认

- `aigcplatform-steering.com` 的 DNS 已经指向 nj304 上对外的 nginx，且解析只在维护窗口核对。
- TLS 证书和私钥已经部署在该 nginx 实际读取的路径。模板里的文件名只是占位，不能覆盖现场证书。
- 固定下一跳是应用网关 Service。建议地址 `aigc-app-gateway:8080`，由网关进程提供，不把远端业务端口写进 nginx。
- API 与网关使用同一数据库。连接串由现有 Secret 注入，不写入镜像、交接记录或 nginx 配置。
- 生产设置 `ApplicationGateway__Probe=required` 和 `ApplicationGateway__AllowedUpstreamHosts`。允许范围为空时，必需探针模式会拒绝登记路由。
- 远端应用接受子路径，页面、静态资源、API、重定向和 WebSocket 都留在网关域名下。
- 源站通过网络策略或等价的源站鉴权拒绝浏览器直连。路由无效或鉴权失败时，网关不会改写成源站地址。
- 门户所在源必须列入 `ApplicationGateway__AllowedSubmitOrigins`，否则表单 POST 会被拒绝。
- 第二个应用只新增路由表记录，nginx `-t` 前后配置摘要保持不变，且不需要 reload。

## 首次上线顺序

1. 在维护窗口备份当前 nginx 配置。单文件 bind mount 要原位复制，保留 inode。
2. 先部署应用网关，但不要把公网流量切过去。确认 `/health` 返回 `application-gateway`。
3. 把增量 location 合并进候选配置。保留现有中台、`/api/` 和已有 TLS、日志、白名单。
4. 在候选文件上执行 `nginx -t`。不要用会打印全部配置的 `nginx -T`。
5. 核对容器内实际文件后，再 `nginx -s reload`。reload 前确认回滚副本可读。
6. 用一个已允许的远端应用完成发布回调，确认路由状态为 Ready。
7. 从应用集合打开，确认地址保持 `https://aigcplatform-steering.com/{slug}/`，刷新和深链在会话内可用，无会话直接输入被拒绝。
8. 撤销授权或下架后，新的页面、资源和 WebSocket 握手被拒绝。已建立的长连接由所在网关副本在最多 15 秒的巡检内取消，转发活动超时也不会超过该会话创建时记下的空闲和绝对时限。
9. 再登记第二个应用，重复打开。nginx 配置文件和进程启动时间不应因为第二个应用发生变化。

## 回滚

1. 把 nginx 候选配置原位恢复为上线前的备份。
2. 执行 `nginx -t`，成功后再 reload。
3. 停止或缩容应用网关 Deployment。保留数据库、路由表、个人授权和配置审计，便于下次继续。
4. 不删除发布申请、访问申请和流程绑定。回滚边缘转发不会自动撤销已经授予的个人权限；需要停止访问时在中台撤销授权。

会话 Cookie 名称是 `aigc_app_session`。票据只出现在启动表单正文里，不进入 URL，也不转发给远端业务应用。

## 内部上游证书

网关默认校验上游 HTTPS 证书。若业务源站使用自签名证书或网关不信任的内部 CA，可优先将签发 CA 加入容器的信任库。需要临时放行时，在新版网关 Deployment 的 `gateway` 容器设置 `ApplicationGateway__AcceptInvalidUpstreamCertificates=true`。目标源站必须以具体主机名或 IP 出现在 `ApplicationGateway__AllowedUpstreamHosts__N` 中。通配符规则不会启用证书豁免。

现有 Ready 路由的访问由网关处理，只需在网关容器启用该开关。若发布回调也需要探测同一个上游，在 API 升级到包含相同证书策略的版本后，再按需为 API 单独设置该开关。网关日志中的 `SecureConnectionError` 表示应检查上游 TLS 握手，可结合路由 slug 定位。证书恢复可信后，移除相应容器的临时开关。

### 现有路由的网关修复包

在 nj304 导入 `aigc-gateway-2026-11-20-gateway-tls-linux-amd64.tar`。若已确认需要临时放行内部证书，先核对 `aigc-settings` 中的上游允许名单包含业务 URL 的具体主机名或 IP，再在 Kubernetes 控制端用一次补丁同时更新镜像和网关环境变量。

镜像包 SHA-256 为 `4e9a60e4a61f38c3c00c356056e568d7a0ff63b17c71342eb2eee80bce1158f2`。

```sh
# nj304
sudo ctr -n k8s.io images import aigc-gateway-2026-11-20-gateway-tls-linux-amd64.tar

# Kubernetes 控制端
kubectl -n bosch-aigc-dsh patch deployment/aigc-app-gateway --type=strategic \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"gateway","image":"docker.io/library/aigc-gateway:2026-11-20-gateway-tls","env":[{"name":"ApplicationGateway__AcceptInvalidUpstreamCertificates","value":"true"}]}]}}}}'
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-app-gateway --timeout=120s
```

从应用集合重新打开原应用，确认业务页和静态资源返回成功。如网关更新需要回退，用 `kubectl -n bosch-aigc-dsh rollout undo deployment/aigc-app-gateway` 恢复上一版 Pod 模板。若只需撤销证书放行，可用 `kubectl -n bosch-aigc-dsh set env deployment/aigc-app-gateway ApplicationGateway__AcceptInvalidUpstreamCertificates=false --containers=gateway`。

## Portal 配置保存修复

`aigc-portal-2026-11-20-gateway-settings-save-linux-amd64.tar` 基于 11 月 19 日应用网关交付的 Portal 源码，只补齐保存函数的导入。SHA-256 为 `bd6ddfeec7b9773548fd8e9246b94f5c38b0585dd678574c6f9d9b01fd54e874`。

```sh
# nj304
sudo ctr -n k8s.io images import aigc-portal-2026-11-20-gateway-settings-save-linux-amd64.tar

# Kubernetes 控制端
kubectl -n bosch-aigc-dsh set image deployment/aigc-portal \
  portal=docker.io/library/aigc-portal:2026-11-20-gateway-settings-save
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-portal --timeout=120s
```

滚动完成后，重新打开「应用网关配置」，用计划生效的时长保存，确认成功提示和重新加载的值。需要回退时执行 `kubectl -n bosch-aigc-dsh rollout undo deployment/aigc-portal`。

## 登记应用访问申请

`aigc-update-2026-11-20-registered-access-api-portal-linux-amd64.tar` 包含 API 和 Portal 镜像。Portal 已包含配置保存修复。SHA-256 为 `49cf2764deda4451ac9f070a9b876c1c837fe6b0889dba4d2a4c51d2e69f00f3`。

本次 API 启动时扩展访问申请和个人授权表。先按 [部署手册](../DEPLOYMENT-RUNBOOK.md) 核对生产工作负载、记录当前镜像并备份数据库，然后先升级 API，再升级 Portal。

```sh
# nj304
sudo ctr -n k8s.io images import aigc-update-2026-11-20-registered-access-api-portal-linux-amd64.tar

# Kubernetes 控制端
kubectl -n bosch-aigc-dsh set image deployment/aigc-api \
  api=docker.io/library/aigc-api:2026-11-20-registered-access
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-api --timeout=300s
kubectl -n bosch-aigc-dsh set image deployment/aigc-portal \
  portal=docker.io/library/aigc-portal:2026-11-20-registered-access
kubectl -n bosch-aigc-dsh rollout status deployment/aigc-portal --timeout=300s
```

在「流程设计 → 流程绑定」确认「访问申请」已有已发布流程。用一个不在访问范围内的用户打开受限登记应用，确认可以在卡片入口填写原因。逐级审批，终审后用同一账号重新点击卡片，并在「应用网关配置 → 生效中的个人授权」核对授权。另一位无权限用户仍需申请。

如果只需回退页面，可以单独回退 Portal。已有登记应用申请或授权写入后，旧 API 无法识别这些记录的目标类型，API 回退需要一并处理数据库兼容性并保留新增的审批与授权记录。

## 通配应用代理域名

发布应用在启用 `ApplicationGateway__ProxyHostSuffix=aigcplatform.boschhuayu-steering.com` 后，从应用集合打开 `https://<slug>.aigcplatform.boschhuayu-steering.com`。Nginx 将该域名下的完整请求路径交给应用网关，主域名继续使用现有 server 配置。启动表单把一次性票据提交到 `/.aigc/launch`，兑换后回到业务部署地址的原始路径。网关会话 Cookie 只属于当前应用主机。已有登记应用仍按登记地址打开。

例如，CAS SSO 的代理入口为 `https://bhss-cas-sso-e3f0ba.aigcplatform.boschhuayu-steering.com/`。主域名 `https://aigcplatform.boschhuayu-steering.com/` 继续由原站点和证书提供服务。

### 开通与升级顺序

1. 让 IT 确认内网通配 DNS 指向 nj304 正式入口，证书 SAN 覆盖 `*.aigcplatform.boschhuayu-steering.com`。证书和私钥通过现场流程准备。按现有部署手册记录 API、Portal、网关和边缘 Deployment 修订。
2. 在 nj304 导入 `aigc-update-2026-11-20-apps-wildcard-manual-deploy-linux-amd64.tar`。先更新 Portal，它同时支持旧入口和新入口。再更新 Gateway 并为它设置域名后缀。API 的启动入口在第 4 步切换。

镜像包 SHA-256 为 `97866e70b399f18a215e098c5e0d20f14bfca7249f929e5a1a1f56d87d54f542`。

```sh
# nj304
sudo ctr -n k8s.io images import aigc-update-2026-11-20-apps-wildcard-manual-deploy-linux-amd64.tar

# Kubernetes 控制端
ns=bosch-aigc-dsh
kubectl -n "$ns" set image deployment/aigc-portal portal=docker.io/library/aigc-portal:2026-11-20-apps-wildcard-manual-deploy
kubectl -n "$ns" rollout status deployment/aigc-portal --timeout=180s
kubectl -n "$ns" patch deployment/aigc-app-gateway --type=strategic \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"gateway","image":"docker.io/library/aigc-gateway:2026-11-20-apps-wildcard-manual-deploy","env":[{"name":"ApplicationGateway__ProxyHostSuffix","value":"aigcplatform.boschhuayu-steering.com"}]}]}}}}'
kubectl -n "$ns" rollout status deployment/aigc-app-gateway --timeout=180s
```

3. 使用 [通配站点配置](../deploy/k8s/bosch-aigc-dsh/app-gateway/aigc-apps.conf) 和 [边缘挂载补丁](../deploy/k8s/bosch-aigc-dsh/app-gateway/aigc-edge-apps.patch.yaml)。两个文件以独立挂载接入同一 Nginx，现场主域名的配置和证书继续使用原有挂载。现有边缘 Deployment 为单副本 `Recreate` 时，此次改挂载会有一次短暂中断。

```sh
kubectl -n "$ns" create secret tls aigc-edge-apps-tls --cert=/secure/apps-fullchain.pem --key=/secure/apps-private.key
kubectl -n "$ns" create configmap aigc-edge-apps --from-file=aigc-apps.conf=./aigc-apps.conf
kubectl -n "$ns" patch deployment/aigc-edge --type=strategic --patch-file ./aigc-edge-apps.patch.yaml --dry-run=server -o name
kubectl -n "$ns" patch deployment/aigc-edge --type=strategic --patch-file ./aigc-edge-apps.patch.yaml
kubectl -n "$ns" rollout status deployment/aigc-edge --timeout=180s
kubectl -n "$ns" exec deployment/aigc-edge -- nginx -t
```

现场首次挂载前，可把新增站点配置和通配证书挂到同版本 Nginx 的验证实例执行 `nginx -t`。先检查主域名首页和健康接口，再用无会话浏览器访问已存在的业务 slug 子域名，预期提示「请从 AIGC 应用集合进入」。未知 slug 应返回 404。

4. 切换 API，开启从应用集合签发子域名票据。沿用现有 `AllowedSubmitOrigins` 和 `AllowedUpstreamHosts`，确认提交来源包含 Portal 主域名。

```sh
kubectl -n "$ns" patch deployment/aigc-api --type=strategic \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"api","image":"docker.io/library/aigc-api:2026-11-20-apps-wildcard-manual-deploy","env":[{"name":"ApplicationGateway__ProxyHostSuffix","value":"aigcplatform.boschhuayu-steering.com"}]}]}}}}'
kubectl -n "$ns" rollout status deployment/aigc-api --timeout=300s
```

### 现场验收与回滚

- 用同一业务账号分别打开 CAS SSO 原入口和 AIGC 应用卡片。检查通配证书、Logo、实际 API、业务登录回调以及应用使用的 WebSocket。另用无痕窗口粘贴代理地址，检查未授权提示。
- 应用子域名模式会转发业务 Cookie 和 Authorization，网关会话等 AIGC Cookie 留在网关，业务响应 Cookie 限定到当前代理主机。发往源站的同源 Origin/Referer 会与源站匹配，外部登录跳转保持目标地址。若业务使用固定原站绝对地址、绑定域名的 SSO 回调或跨域 Cookie，仍需按该应用配置并实际验收。
- 如需切回路径入口，先在 API 执行 `kubectl -n "$ns" set env deployment/aigc-api ApplicationGateway__ProxyHostSuffix= --containers=api` 并等待 rollout。Portal 能继续处理旧启动地址。待不再使用通配入口后，按第 1 步记录的边缘 Deployment 修订回退挂载。

## 手动录入部署结果

用有「流程设计」权限的账号打开「第三方服务 → 第三方调用记录」。找到当前等待结果、尚未过期的 `deployment` 调用，在操作列点「触发部署回调」，输入已部署应用的 HTTPS 地址，再点「确认触发」。

API 根据调用记录定位流程实例和节点，按该实例绑定的流程版本录入部署成功结果，保存操作者并继续后续流程。节点的结果事件应是 `deploy.completed.v1`，且配置了部署地址结果字段。配置了提交版本校验的部署节点仍需提交包含 `commitSha` 的正式回调。
