# KnowEngine 服务端同步改造指南

日期：2026-10-28。本文面向 KnowEngine 服务端团队，说明为接入「DSH 无感身份交换」需要在 KnowEngine 侧完成的同步改造。

协议合同见 [KnowEngine MCP 无感身份交换改造说明](KNOWENGINE-MCP-TOKEN-EXCHANGE.md)（下称《合同》）；本文在其基础上补充实施细节、AIGC/DSH 调用方的实际行为参数与验收步骤。两边不一致时以《合同》为准并同步修订本文。

## 1. 背景与目标

员工登录弯崽工作助手（DSH）后，DSH 需要调用 KnowEngine 的 MCP 工具（知识库检索等）。现状是 DSH 无法拿到 KnowEngine 侧的员工身份，只能走共享账号或二次登录。

本次改造后：

- AIGC 平台为已登录且获授权的员工签发 30～120 秒的短期身份断言（RS256 JWT）。
- DSH 拿着断言调 KnowEngine 新增的 Token Exchange 接口，无浏览器交互地换取短期 MCP Bearer Token。
- KnowEngine 用既有 MCP Token 验证管线校验该 Token，`/mcp` 端点无需感知断言的存在。

KnowEngine 侧**不改** `/mcp` 工具本身与知识库 ACL，只新增一个 Token Exchange 端点和配套的验签/防重放/员工映射逻辑。

## 2. 端到端流程

```text
DSH ──①登录(AIGC Token)──> AIGC
DSH <─②policy(含 knowengine 条目)── AIGC
DSH ──③ POST /v1/mcp/{id}/identity-assertion (Bearer AIGC Token)──> AIGC
DSH <─④ { assertion } (短期 JWT)── AIGC
DSH ──⑤ POST /oauth2/dsh-token { assertion }──> KnowEngine   ← 本文改造点
DSH <─⑥ { access_token, expires_in, ... }──────── KnowEngine   ← 本文改造点
DSH ──⑦ POST /mcp (Bearer access_token)──> KnowEngine（既有管线）
```

①～④ 由 AIGC/DSH 完成，已实现并通过本地验证；⑤⑥ 是 KnowEngine 唯一需要新增的接口；⑦ 复用现有 OAuth/CAS 签发的 MCP Token 验证管线。

## 3. 改造清单总览

| # | 模块 | 改动 | 类型 |
|---|---|---|---|
| 1 | 路由 | 新增 `POST /oauth2/dsh-token` | 新增 |
| 2 | 信任配置 | 存储 AIGC 公钥（按 `kid` 索引）+ issuer/audience 白名单 | 新增 |
| 3 | 验签 | RS256 JWT 校验（签名、iss、aud、nbf/iat/exp、算法白名单） | 新增 |
| 4 | 防重放 | `jti` 单次兑换（建议 Redis `SET NX EX`） | 新增 |
| 5 | 员工映射 | 按 `sub`（员工工号）映射 KnowEngine 账号并校验状态 | 新增 |
| 6 | Token 签发 | 签发面向 `/mcp` 的短期 Bearer Token（复用既有签发管线） | 扩展 |
| 7 | 限流 | Exchange 端点按客户端/IP 限流（可选但建议） | 新增 |
| 8 | 审计 | 记录 request_id、jti、sub、结果；不得记录断言或 Token 全文 | 新增 |

## 4. 接口规格：`POST /oauth2/dsh-token`

### 请求

```http
POST /oauth2/dsh-token HTTP/1.1
Content-Type: application/json
```

请求体只有一个字段（DSH 侧实现固定如此，不会附带其他参数）：

```json
{ "assertion": "<AIGC签发的JWT字符串>" }
```

注意：

- DSH 的 fetch 设置 `redirect: 'error'`，**任何 3xx 重定向都会直接失败**。该端点不得返回重定向。
- DSH 不发送 Cookie，不发送 Basic/客户端证书；端点不要依赖会话。
- 响应必须 `Cache-Control: no-store`。

### 成功响应

```http
HTTP/1.1 200 OK
Cache-Control: no-store
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

DSH 侧校验规则（不满足即视为兑换失败，连接置为不可用）：

- `access_token`：非空字符串。
- `token_type`：大小写不敏感地等于 `bearer`。
- `expires_in`：**正整数秒**。DSH 不写死有效期，完全以此为准。
- `scope`：可选字符串。
- 第一期**不需要** `refresh_token`。

## 5. 断言（JWT）规格——AIGC 实际签发行为

以下均为 AIGC 当前实现的真实行为（源码 `McpIdentityAssertionIssuer.cs`），KnowEngine 验签按此对齐：

| 项 | 值 |
|---|---|
| 算法 | `RS256`（仅此一种） |
| `iss` | `bhss-aigc`（部署可配；以联调时约定的值为准） |
| `aud` | `knowengine-mcp`（AIGC 每服务配置） |
| `sub` | 员工工号，**已标准化为小写** |
| `jti` | 随机 GUID（小写连字符格式），每次签发全新 |
| `name` / `email` | 展示用途，不参与授权决策 |
| `aigc_user_id` | AIGC 内部用户 GUID，仅辅助映射/对账 |
| `department_id` | 可选；有部门时才出现 |
| `nbf` | `iat` 减 5 秒（容忍双方轻微时钟偏差） |
| `iat` / `exp` | 有效期 = 配置值并夹取到 **30～120 秒**，默认 60 秒 |
| Header `kid` | 当前为 `aigc-2026-10` 形式，以部署配置为准 |

示例 Payload：

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

## 6. 验签管线实施

收到请求后按固定顺序执行（顺序即失败原因归属，便于排障）：

```text
1. 解析请求体        → 缺 assertion / 非 JSON          → 400 invalid_request
2. 解析 JWT          → 格式损坏                        → 400 invalid_request
3. 读 Header.kid     → 未知 kid                         → 401 invalid_assertion
4. 算法白名单        → alg≠RS256（含 alg=none）         → 401 invalid_assertion
5. 验 RSA 签名       → 签名不匹配（含篡改 payload）      → 401 invalid_assertion
6. 校验 iss/aud      → iss≠bhss-aigc 或 aud≠knowengine-mcp → 401 invalid_assertion
7. 校验 nbf/iat/exp  → 过期或未生效（建议容差30秒）      → 401 assertion_expired
8. jti 一次性兑换    → 重复 jti                         → 401 assertion_replayed
9. 员工映射          → sub 无对应账号/停用               → 403 user_disabled
10. Scope 检查       → dsh-desktop 未获准所需 scope     → 403 scope_denied
11. 签发 Token       → 成功                             → 200
```

实现要点：

- **算法必须白名单固定为 RS256**，绝不允许从 Header 的 `alg` 值动态选择算法（防降级攻击）。
- `sub` 只能来自验签后的 Payload；**禁止**用请求参数、URL 或未签名 Header 中的同名/同义字段覆盖。
- 验签建议时钟偏差容忍 30 秒（AIGC 的 `nbf` 已自带 5 秒余量）。
- 公钥按 `kid` 索引，允许同时配置多个（轮换窗口期新旧并存，见第 12 节）。

## 7. 防重放（jti 单次兑换）

断言有效期最长 120 秒，但仍必须一次性兑换：

- 建议 Redis：`SET aigc:jti:<jti> 1 NX EX <断言剩余秒数 + 30>`。
- 保存时长必须覆盖断言剩余有效期（否则过期断言可能被重放，但会被第 7 步过期校验拦住——两者互为兜底）。
- 兑换成功后 `jti` 记录保留至过期，重复提交返回 `assertion_replayed`。
- 若暂时无 Redis，可用进程内缓存 + 有限 TTL（多副本部署时会漏判，须在上线前说明并尽快补 Redis）。

## 8. 员工映射与授权

- 以 `sub`（小写工号）查找 KnowEngine 员工表。
- 映射策略建议：精确匹配工号；如需自动建号，仅创建最小权限的普通员工账号，且开关默认关闭。
- 账号停用、不存在、且不允许自动创建 → `403 user_disabled`。
- `name`/`email`/`department_id` 仅作展示或辅助映射，**不得**据此授予管理角色或知识库权限。
- 换取的 MCP Token 与该员工的普通登录 Token 同权：知识库可见范围仍由 KnowEngine ACL 在工具调用时决定。

## 9. MCP Token 签发要求

复用现有 OAuth/CAS → MCP Token 管线，但 Token 至少绑定：

- KnowEngine 自己的 issuer
- 员工 `sub`
- audience = 生产 MCP Resource URI（如 `https://airag-ne.boschhuayu-steering.com:8080/mcp`）
- Scope（最小集合，见下）
- `client_id=dsh-desktop`（标识来源，便于审计与撤权）
- `iat`、`exp`、唯一 `jti`

建议 `expires_in = 600`（10 分钟）。DSH 会在剩余不足 60 秒时自动重新兑换，无需 refresh_token。

若撤权必须**立即**生效：仅靠过期则撤权延迟上限 = Token 有效期（10 分钟）。如需更短，KnowEngine 须维护 Token 撤销列表或在关键工具调用中回查员工状态——这是 KnowEngine 侧的可选项，按业务要求决定。

## 10. 错误码合同

响应体统一 JSON：

```json
{ "error": "invalid_assertion", "error_description": "assertion audience mismatch", "request_id": "..." }
```

| HTTP | `error` | 场景 | DSH 侧行为 |
|---:|---|---|---|
| 400 | `invalid_request` | 缺少或无法解析 assertion | 连接置为不可用，下个周期重试 |
| 401 | `invalid_assertion` | 签名、iss、aud、算法、kid 错误 | 同上 |
| 401 | `assertion_expired` | 过期或未生效 | 同上 |
| 401 | `assertion_replayed` | jti 已兑换 | 同上 |
| 403 | `user_disabled` | 员工不存在/停用/不允许自动创建 | 同上 |
| 403 | `scope_denied` | dsh-desktop 未获准 scope | 同上 |
| 429 | `rate_limited` | 兑换频率超限 | 同上（退避后重试） |
| 503 | `identity_key_unavailable` | 公钥/依赖暂不可用 | 同上 |

DSH 对任何非 2xx 都**不会**降级为匿名或共享账号。日志可记 `request_id`、`jti`、`sub`、结果码；**禁止**记录完整 assertion、access_token 或内部堆栈。

## 11. KnowEngine 侧配置项

```text
# 信任的 AIGC 断言签发方
aigc.trusted-issuer=bhss-aigc
aigc.assertion-audience=knowengine-mcp

# 公钥（按 kid 索引；轮换期可同时配置多把）
aigc.keys[0].kid=<与AIGC约定的kid>
aigc.keys[0].public-key=<PEM公钥>

# 兑换策略
exchange.clock-skew-seconds=30
exchange.token-lifetime-seconds=600
exchange.jti-store=redis://...        # 或 none（单副本临时方案）
exchange.client-id=dsh-desktop
exchange.allowed-scopes=kb:read,document:read,retrieval:read,knowledge:ask

# 员工映射
employee.match-field=employee_no      # 对应断言 sub（小写工号）
employee.auto-create=false
```

具体键名按 KnowEngine 配置体系自定，语义对齐即可。

## 12. 密钥信任建立与轮换

- KnowEngine 只持有 AIGC **公钥**；AIGC 私钥只存在于 AIGC 部署秘密中，双方任何文档、代码库、日志中都不出现。
- 首次建立：通过受控渠道（线下或加密通道）交付公钥，双方核对**公钥指纹**、`kid`、`iss`、`aud` 四要素并留档。
- 轮换流程（AIGC 发起）：
  1. AIGC 生成新密钥对，新公钥交 KnowEngine；
  2. KnowEngine 配置同时接受新旧两个 `kid`；
  3. AIGC 切换签名 `kid`；
  4. 等待旧断言最大有效期（120 秒）+ 时钟容差过后，KnowEngine 移除旧公钥。
- 建议把「已配置 kid 列表」做成运行时可查（管理接口或日志），便于联调排障。

## 13. 与 DSH 客户端行为对齐（时间参数）

KnowEngine 联调排障时需要知道的 DSH 实际行为：

| 行为 | 参数 | 说明 |
|---|---|---|
| 策略轮询 | 60 秒 | 断言失败后，最长等一个周期才重试 |
| 请求超时 | 30 秒 | Exchange 响应超过 30 秒即失败 |
| Token 复用 | 剩余 > 60 秒才复用 | 剩余不足 60 秒自动重新走断言+兑换 |
| 并发兑换 | 单连接同时只有一个 in-flight | 不会并发轰炸 Exchange |
| 直连地址 | 必须 `https://`（localhost 除外） | Exchange 与 `/mcp` 地址都必须 HTTPS |
| 撤权/账号切换 | 立即断开 | AIGC 策略变化 → DSH 下一周期移除工具 |
| 重定向 | `redirect: 'error'` | 任何 3xx 都失败 |

对 KnowEngine 的含义：`expires_in` 给 600 秒即可满足「用户无感」，给太短（<120 秒）会导致频繁兑换，给太长会拉长撤权延迟窗口。

## 14. 测试与验收

### 单元/集成测试（KnowEngine 侧，交付前自测）

- [ ] 合法断言（真实 RS256 签发）→ 200，返回结构完整的 Token
- [ ] 篡改 payload → `invalid_assertion`
- [ ] `alg=none` / 未知 `kid` / 错误算法 → `invalid_assertion`
- [ ] `iss` 或 `aud` 不符 → `invalid_assertion`
- [ ] 过期 / 未生效断言 → `assertion_expired`
- [ ] 同一 `jti` 二次兑换 → `assertion_replayed`
- [ ] 停用员工 → `user_disabled`
- [ ] 响应不含完整 assertion、access_token；日志同理
- [ ] 3xx 重定向不出现（直连端点）

### 联调验收（三方环境）

按《合同》第「联调验收」节执行，重点：

1. 未登录/未授权用户无法取得断言（AIGC 侧保证）。
2. `sub` 即实际登录员工，无法通过请求体伪造。
3. `knowengine_get_capabilities` 返回该员工身份与约定 scope。
4. `knowengine_list_knowledge_bases` 仅返回该员工 ACL 内的知识库。
5. DSH 启动、Token 到期自动兑换，全程无浏览器弹窗。
6. AIGC 撤权后，最长一个 Token 有效期内 DSH 调用失败；账号切换后旧连接立即清理。
7. 三方服务端与客户端日志均无敏感凭据。

## 15. 安全注意事项

- 私钥永不出现在 KnowEngine（本来就不持有）；公钥可以出现在配置，但轮换须走受控流程。
- Exchange 端点必须 HTTPS，建议按客户端限流（429）。
- 验签失败不要回显「验签内部状态」（如密钥指纹、缓存命中情况），统一 `error_description` 简短措辞。
- 审计记录保留期与格式按 KnowEngine 既有合规要求；新增字段建议：`jti`、`sub`、`client_id=dsh-desktop`、`request_id`、结果码。

## 附录：联调对接人所需信息清单

KnowEngine 联调前需要从 AIGC 侧获取：

1. 生产 `iss`、`aud`、当前 `kid` 与公钥（PEM）。
2. 约定的 scope 列表与 MCP Resource URI。
3. 一组测试员工工号（含一名已停用账号，用于验证 `user_disabled`）。

AIGC 侧已完成事项（供参考，无需 KnowEngine 操作）：断言签发端点 `/v1/mcp/{id}/identity-assertion`、DSH 自动兑换与缓存、管理端配置界面，均已于 2026-10-28 通过本地聚焦验证（API 5/5、DSH 3/3、Portal 6/6）。
