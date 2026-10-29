# KnowEngine MCP 无感身份对接说明

更新日期：2026-10-28

## 1. 对接目标

员工登录弯崽工作助手（DSH）后，可以直接使用 KnowEngine MCP，不需要点击连接后再次打开浏览器，也不需要重复进行 BHSS SSO 登录。

本方案不把 BHSS 密码、CAS Ticket、浏览器 Cookie 或 AIGC 登录 Token 交给 KnowEngine。AIGC 只签发一张有效期约 60 秒的员工身份断言；KnowEngine 验证断言后，签发自己的短期 MCP Access Token。

## 2. 完整调用链

```text
员工通过 BHSS SSO 登录 DSH
        │
        │ AIGC 登录 Token
        ▼
AIGC 判断员工是否获得 KnowEngine MCP 授权
        │
        │ RS256 签名、约 60 秒有效的 assertion
        ▼
DSH 调用 KnowEngine POST /oauth2/dsh-token
        │
        │ { "assertion": "<JWT>" }
        ▼
KnowEngine 使用 AIGC 公钥验签并映射员工
        │
        │ 约 10 分钟有效的 MCP Access Token
        ▼
DSH 使用 Bearer Token 连接 KnowEngine /mcp
        │
        ▼
初始化 MCP、发现工具并按员工知识库 ACL 执行业务调用
```

## 3. 各系统职责

### 3.1 AIGC

- 使用当前已登录会话确认员工身份。
- 检查 MCP 是否启用、发布，以及当前员工、角色或部门是否获得授权。
- 使用 AIGC RSA 私钥签发短期 JWT assertion。
- assertion 中的员工工号来自服务端登录会话，不能由 DSH 请求体指定。
- 账号停用、MCP 未授权或认证模式不匹配时，不得签发 assertion。

### 3.2 DSH

- 使用现有 AIGC 登录 Token 申请 assertion。
- 把 assertion 原样提交给 KnowEngine Token Exchange 接口。
- 缓存 KnowEngine 返回的 MCP Token，并在即将过期时自动重新兑换。
- 携带 KnowEngine Bearer Token 调用 Streamable HTTP MCP。
- 用户退出、切换账号或失去授权时，移除对应连接和工具。
- 不持有 AIGC RSA 私钥，不构造或修改员工身份。

### 3.3 KnowEngine

- 新增 `POST /oauth2/dsh-token` 接口。
- 保存 AIGC 公钥，根据 JWT Header 中的 `kid` 选择公钥。
- 校验 RS256 签名、issuer、audience、有效期及一次性 `jti`。
- 根据 `sub` 映射 KnowEngine 中的真实员工账号。
- 为员工签发 KnowEngine 自己的短期 MCP Access Token。
- 在实际知识库调用中继续执行员工 ACL，不能依靠 AIGC 部门字段直接授予权限。
- `/mcp` 只接受 KnowEngine 自己签发的 Access Token，不直接接受 AIGC assertion。

## 4. assertion 是什么

assertion 是 AIGC 使用 RS256 签名的短期 JWT。它用于向 KnowEngine 证明：某个员工身份已经由 AIGC 登录体系确认。

JWT 由三段组成：

```text
Base64Url(Header).Base64Url(Payload).Base64Url(Signature)
```

Header 和 Payload 可以被读取，但不能在不破坏签名的情况下修改。它们不是密文，传输保密依靠 HTTPS。

### 4.1 Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "aigc-2026-10"
}
```

- `alg`：签名算法，只允许 `RS256`。
- `typ`：内容类型为 JWT。
- `kid`：密钥编号，KnowEngine 用它选择对应的 AIGC 公钥。

### 4.2 Payload

```json
{
  "iss": "bhss-aigc",
  "sub": "nj00663",
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

| 字段 | 含义 |
|---|---|
| `iss` | 签发方，固定为 `bhss-aigc` |
| `sub` | 当前登录员工的标准化小写工号 |
| `aud` | 断言接收方，固定为 `knowengine-mcp` |
| `name`、`email` | 辅助展示或员工映射，不能直接授予业务权限 |
| `aigc_user_id` | 员工在 AIGC 中的内部用户 ID |
| `department_id` | AIGC 部门 ID，只作辅助信息 |
| `nbf` | 在此时间之前断言不能使用 |
| `iat` | 断言签发时间 |
| `exp` | 断言过期时间，通常约为 `iat + 60秒` |
| `jti` | 本次断言唯一编号，用于防止重复兑换 |

Payload 中不得包含 BHSS 密码、CAS Ticket、Cookie、AIGC 登录 Token、KnowEngine Token 或任何私钥。

## 5. 如何理解 RS256、公钥和私钥

RSA 会生成一对相互关联、用途不同的密钥：

```text
AIGC 私钥：用于签名，只能由 AIGC 保管
AIGC 公钥：用于验签，可以交给 KnowEngine
```

可以把私钥理解为 AIGC 的印章，把公钥理解为 KnowEngine 使用的验章工具。公钥可以判断签名是否来自对应私钥，但不能生成相同的合法签名。

`RS256` 表示使用 RSA 非对称签名和 SHA-256 摘要算法。这里的 `256` 是 SHA-256 摘要位数，不是 RSA 密钥长度；RSA 密钥通常至少使用 2048 位。

签名过程可以简化为：

```text
Base64Url(Header) + "." + Base64Url(Payload)
                         │
                         ▼
                  计算 SHA-256 摘要
                         │
                         ▼
                  AIGC RSA 私钥签名
                         │
                         ▼
                     Signature
```

如果有人把 Payload 中的：

```json
"sub": "nj00663"
```

修改成：

```json
"sub": "admin"
```

Header/Payload 的 SHA-256 摘要会改变，但攻击者没有 AIGC 私钥，无法生成与修改后内容匹配的新签名。KnowEngine 使用公钥验签时会失败并返回 `invalid_assertion`。

因此，RS256 提供的是：

- 来源真实性：验签成功说明 assertion 由对应 AIGC 私钥签发。
- 内容完整性：Header 或 Payload 被修改后验签失败。
- 非对称信任：KnowEngine 只持有公钥，不能伪造 AIGC assertion。
- 不提供内容加密：Payload 仍然可读，必须使用 HTTPS 保护传输。

## 6. Token Exchange

DSH 向 KnowEngine 请求：

```http
POST /oauth2/dsh-token
Content-Type: application/json
Accept: application/json
```

```json
{
  "assertion": "<AIGC签发的短期JWT>"
}
```

KnowEngine 必须按以下顺序校验：

1. 只允许约定的 `RS256`，拒绝 `alg=none` 和其他算法。
2. 根据 `kid` 找到已信任的 AIGC 公钥。
3. 验证 JWT 签名。
4. 精确校验 `iss=bhss-aigc` 和 `aud=knowengine-mcp`。
5. 校验 `nbf`、`iat`、`exp`，双方可约定最多约 30 秒时钟偏差。
6. 使用 `jti` 做一次性兑换，拒绝重复使用。
7. 根据 `sub` 查找并检查 KnowEngine 员工状态。
8. 按 `dsh-desktop` 获准的最小 Scope 签发 Token。

成功响应示例：

```json
{
  "access_token": "<KnowEngine签发的MCP Token>",
  "token_type": "Bearer",
  "expires_in": 600,
  "scope": "kb:read document:read retrieval:read knowledge:ask"
}
```

## 7. 两种 Token 的区别

| 项目 | AIGC assertion | KnowEngine MCP Token |
|---|---|---|
| 签发方 | AIGC | KnowEngine |
| 作用 | 向 KnowEngine 证明员工身份 | 调用 KnowEngine `/mcp` |
| 建议有效期 | 约 60 秒 | 约 10 分钟 |
| 接收方 | 仅 KnowEngine Token Exchange | KnowEngine MCP Resource |
| 是否直接调用业务工具 | 否 | 是 |

第一期不需要 refresh token。KnowEngine Token 即将过期时，DSH 再向 AIGC 申请一张新 assertion，然后重新兑换，员工无感。

## 8. MCP 调用

获得 KnowEngine Token 后，DSH 调用：

```http
POST /mcp
Authorization: Bearer <KnowEngine access_token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

KnowEngine 的 Token 验证和知识库 ACL 必须与现有认证体系使用同一套业务权限规则。Scope 控制工具能力，具体能看到哪些知识库仍由当前员工 ACL 决定。

## 9. 撤权、退出和账号切换

DSH 在以下情况移除 KnowEngine 连接及其工具：

- 用户退出 DSH。
- 用户切换 AIGC 账号。
- AIGC 账号被停用。
- 管理员撤销用户、角色或部门的 MCP 授权。
- KnowEngine MCP 被停用、取消发布或修改认证模式。

如果 KnowEngine 只依赖 Access Token 自然过期，撤权最长延迟可能等于 Token 有效期。需要立即撤权时，KnowEngine 还应提供 Token 撤销状态或在关键调用中实时回查员工权限。

## 10. 密钥交付与生产配置

密钥分布必须保持：

```text
AIGC Kubernetes Secret
└── RSA 私钥：签发 assertion

KnowEngine
└── RSA 公钥：验证 assertion

DSH
└── 不持有签名私钥或公钥配置
```

AIGC 生产配置：

```text
McpIdentityAssertion__Issuer=bhss-aigc
McpIdentityAssertion__KeyId=aigc-2026-10
McpIdentityAssertion__PrivateKeyPem=<由Kubernetes Secret注入>
McpIdentityAssertion__LifetimeSeconds=60
```

生产环境复用现有 `bosch-aigc-dsh/aigc-secrets`，以 merge patch 增加上述四个键，不创建新的同用途 Secret，不替换或删除既有键。注入后滚动重启 `deployment/aigc-api`。具体命令见仓库根目录的 `DEPLOYMENT-RUNBOOK.md`。

交给 KnowEngine 的材料只能包含公钥、指纹、`kid`、issuer、audience、接口合同和改造说明，绝不能包含 AIGC 私钥。

## 11. 安全边界

- 所有 AIGC、Token Exchange 和 MCP 请求必须使用 HTTPS。
- 不在日志中记录完整 assertion、Access Token、私钥、CAS Ticket 或 Cookie。
- assertion 有效期控制在 30～120 秒，本次配置为 60 秒。
- KnowEngine 必须校验 `aud`，防止 assertion 被其他服务使用。
- KnowEngine 必须校验并消费一次性 `jti`，防止 assertion 重放。
- `name`、`email`、`department_id` 只能辅助映射或展示，不能直接授予管理员或知识库权限。
- 公钥泄露不会使攻击者获得签名能力；私钥泄露必须立即轮换密钥和 `kid`。

## 12. 验收标准

不能只以连接状态显示 `Ready` 作为完成依据。至少完成以下真实链路：

1. 已登录且已授权员工可以从 AIGC 取得 assertion。
2. 未登录、账号停用或未授权员工无法取得 assertion。
3. KnowEngine 能用公钥验证合法 assertion。
4. Payload 被篡改、错误 issuer/audience、过期、未知 `kid` 和重复 `jti` 均被拒绝。
5. KnowEngine 将 `sub` 映射为实际员工并签发最小 Scope Token。
6. DSH 使用 Token 成功初始化 `/mcp` 并发现预期工具。
7. 实际调用工具时，只返回该员工 ACL 允许的知识库内容。
8. Token 到期后 DSH 自动重新兑换，不打开浏览器。
9. 退出、切换账号和撤权后，对应 MCP 连接与工具被清理。
10. 服务端、客户端和审计日志中不存在完整 assertion、Token 或私钥。

## 13. 相关文档

- [KnowEngine MCP Token Exchange 接口合同](KNOWENGINE-MCP-TOKEN-EXCHANGE.md)
- [KnowEngine 服务端改造说明](KNOWENGINE-SERVER-CHANGES.md)
- [AIGC 与 DSH MCP 集成说明](AIGC-DSH-MCP-INTEGRATION.md)
- [生产部署记录](../DEPLOYMENT-RUNBOOK.md)

