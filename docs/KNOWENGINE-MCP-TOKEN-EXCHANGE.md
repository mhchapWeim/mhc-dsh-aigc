# KnowEngine MCP 无感身份交换改造说明

日期：2026-10-28。本文是 AIGC/DSH 与 KnowEngine 的接口合同。AIGC 与 DSH 调用侧已按本文实现；KnowEngine 服务端源码不在本仓库，其改造、部署和真实联调由 KnowEngine 团队完成。

## 目标与边界

员工已经登录弯崽工作助手后，DSH 不再打开浏览器或要求第二次 CAS 登录。AIGC 服务端根据当前登录会话和 MCP 授权签发一张 30～120 秒有效、只面向 KnowEngine 的员工身份断言；DSH 原样把断言提交给 KnowEngine；KnowEngine 验签、映射员工并签发短期 MCP Bearer Token。知识库可见范围仍由 KnowEngine ACL 决定。

DSH 不生成员工身份、不持有 AIGC 签名私钥，也不传员工号、密码、CAS Ticket 或浏览器 Cookie。HTTPS 负责传输保密，JWT 签名负责来源真实性和内容完整性。

```text
DSH --AIGC登录Token--> AIGC /identity-assertion
DSH <--60秒签名JWT---- AIGC
DSH --{ assertion }--> KnowEngine /oauth2/dsh-token
DSH <--MCP Token------ KnowEngine
DSH --Bearer Token----> KnowEngine /mcp
```

## AIGC 身份断言

AIGC 使用 RSA SHA-256（`RS256`）签名 JWT。部署通过秘密注入私钥，不得把私钥写入源码、安装包、日志或本文。

JWT Header：

```json
{"alg":"RS256","typ":"JWT","kid":"aigc-2026-10"}
```

JWT Payload 示例：

```json
{
  "iss": "bhss-aigc",
  "sub": "wh00028",
  "aud": "knowengine-mcp",
  "name": "员工姓名",
  "email": "employee@example.com",
  "aigc_user_id": "00000000-0000-0000-0000-000000000000",
  "department_id": "00000000-0000-0000-0000-000000000000",
  "nbf": 1793176795,
  "iat": 1793176800,
  "exp": 1793176860,
  "jti": "f1e3bba5-9530-4fa4-a594-4d84bc998f91"
}
```

`sub` 是标准化为小写的员工工号；`aud` 必须配置为 `knowengine-mcp`；`jti` 每次随机生成。`name`、`email` 和部门只能辅助展示或账号映射，不能授予 KnowEngine 管理角色或知识库权限。

## KnowEngine 必须新增的接口

### Token Exchange

```http
POST /oauth2/dsh-token
Content-Type: application/json
Accept: application/json
```

请求体只有一个字段：

```json
{
  "assertion": "<AIGC签发的短期JWT>"
}
```

成功响应：

```http
HTTP/1.1 200 OK
Cache-Control: no-store
Pragma: no-cache
Content-Type: application/json
```

```json
{
  "access_token": "<KnowEngine签发的MCP Token>",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "kb:read document:read retrieval:read knowledge:ask"
}
```

`expires_in` 必须是大于零的整数秒，DSH 不写死有效期。第一期不需要 `refresh_token`：Token 剩余不足60秒时，DSH自动重新申请断言并兑换，用户仍然无感。

### 验证顺序

KnowEngine 收到请求后必须：

1. 根据 `kid` 选择已信任的 AIGC 公钥，并只允许约定的 `RS256` 算法。
2. 验证 JWT 签名，拒绝 `alg=none`、未知算法和未知 `kid`。
3. 精确校验 `iss=bhss-aigc` 和 `aud=knowengine-mcp`。
4. 校验 `nbf`、`iat`、`exp`，最多允许双方约定的时钟偏差，建议30秒。
5. 校验 `sub` 为有效员工工号；禁止从请求参数或未签名 Header 覆盖它。
6. 使用 `jti` 做一次性兑换。建议 Redis `SET ... NX EX`，保存时间覆盖断言剩余有效期。
7. 按 `sub` 查找 KnowEngine 员工；账号停用或无法映射时拒绝。
8. 只签发 `dsh-desktop` 获准的最小 Scope。知识库 ACL 在实际工具调用时继续检查。
9. 签发 `aud` 为生产 MCP Resource URI 的短期 access token。

建议 Token 有效期10分钟。若撤权必须立即生效，KnowEngine还需维护 Token 撤销状态或在关键调用中回查；仅依靠过期时，撤权最长延迟等于 Token 有效期。

## MCP Token 与调用

KnowEngine签发的 Token 应与现有 OAuth/CAS 流程签发的 MCP Token使用相同验证管线。`/mcp` 无需识别 AIGC assertion，只接受 KnowEngine自己的 access token：

```http
POST /mcp
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

Token至少应绑定：KnowEngine issuer、员工 `sub`、生产 MCP Resource audience、Scope、`client_id=dsh-desktop`、签发时间、过期时间和唯一 `jti`。Scope只控制工具能力；具体知识库仍检查该员工 ACL。

## 错误合同

错误响应使用 JSON，不返回 Token、完整 assertion、CAS Ticket 或内部堆栈：

```json
{"error":"invalid_assertion","error_description":"assertion audience mismatch","request_id":"..."}
```

| HTTP | `error` | 场景 |
|---:|---|---|
| 400 | `invalid_request` | 缺少或无法解析 assertion |
| 401 | `invalid_assertion` | 签名、issuer、audience、算法或 key id 错误 |
| 401 | `assertion_expired` | 断言过期或尚未生效 |
| 401 | `assertion_replayed` | `jti` 已兑换 |
| 403 | `user_disabled` | 员工不存在、停用或不允许自动创建 |
| 403 | `scope_denied` | DSH 客户端不允许所需 Scope |
| 429 | `rate_limited` | 兑换频率超限 |
| 503 | `identity_key_unavailable` | 公钥或身份依赖暂时不可用 |

DSH 对非2xx响应不会降级为匿名或共享服务账号；连接器显示不可用并在下一次策略周期重试。日志可记录 `request_id`、`jti`、`sub`、结果和失败原因，但不得记录完整 assertion 或 access token。

## 密钥建立与轮换

KnowEngine只持有 AIGC公钥。生产首次建立信任时，双方应通过受控渠道核对公钥指纹、`kid`、issuer 和 audience。轮换流程：AIGC先生成新密钥并把新公钥交给 KnowEngine；KnowEngine同时接受新旧 `kid`；AIGC切换签名 `kid`；等待旧断言最大有效期结束后移除旧公钥。

AIGC部署配置项：

```text
McpIdentityAssertion__Issuer=bhss-aigc
McpIdentityAssertion__KeyId=<当前kid>
McpIdentityAssertion__PrivateKeyPem=<由部署秘密注入的PKCS#8或PKCS#1 PEM>
McpIdentityAssertion__LifetimeSeconds=60
```

## AIGC MCP 管理配置

KnowEngine条目选择“员工身份断言 / 无感 Token Exchange”，配置：

```text
MCP地址       https://airag-ne.boschhuayu-steering.com:8080/mcp
Token地址     https://airag-ne.boschhuayu-steering.com:8080/oauth2/dsh-token
断言接收方    knowengine-mcp
资源标识       https://airag-ne.boschhuayu-steering.com:8080/mcp
Scope          kb:read document:read retrieval:read knowledge:ask
```

AIGC仍按用户、角色或部门决定谁可以取得身份断言。未发布、未授权、用户停用或认证模式不匹配时都不得签发。

## 联调验收

- 未登录或未获 AIGC MCP授权的用户无法取得 assertion。
- assertion 的 `sub` 是实际登录员工，不能通过请求体修改。
- 篡改 Payload、错误 issuer/audience、过期、未知 `kid` 和重复 `jti` 均被 KnowEngine拒绝。
- 有效 assertion 只兑换到最小 Scope 的短期 Bearer Token。
- `knowengine_get_capabilities` 返回预期员工身份与 Scope。
- `knowengine_list_knowledge_bases` 只返回该员工获授权知识库。
- DSH启动或 Token到期时自动兑换，不打开浏览器、不要求再次登录。
- AIGC账号切换、退出、MCP撤权后旧连接被清理；撤权窗口符合双方约定。
- 服务端、客户端和审计日志均不出现完整 assertion、access token、私钥或 CAS Ticket。

上述验收需要在测试环境使用真实 AIGC、DSH、KnowEngine和员工 ACL完成；本仓库的本地测试不能代替生产联调。
