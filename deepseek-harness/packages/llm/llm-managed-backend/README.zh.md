---
description: "通过令牌获取模型目录并以 NDJSON 转发生成请求的组织后端适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-managed-backend

[English](README.md) | 中文

## 概述

组织可以只提供后端令牌获准使用的模型，并将模型提供方的 API Key 留在后端。适配器从后端读取获准的模型列表与一个短时连接，然后直接对该连接生成。后端在每次读取目录时验证令牌，其签发的连接 Key 限定于获准模型并自行过期；本地目录不是授权决定。本包不验证用户身份，也不签发令牌。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

只有组织后端实现下述 API 时才挂载本包。Desktop 登录把后端签发的令牌保存在 Host 凭据记录中；其他 profile 可以使用配置的凭据引用。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | — | HTTPS 后端根地址，开发时可用回环 HTTP；与 `baseURLEnv` 至少配置一个 |
| `baseURLEnv` | — | 包含后端根地址的可信启动环境变量 |
| `tokenEnv` | — | 存放后端签发用户令牌的凭据引用；与 `tokenKey` 至少配置一个 |
| `tokenKey` | — | `llm-managed-backend` 下的 Host 凭据记录 id；与 `tokenEnv` 至少配置一个 |
| `provider` | `managed` | 本适配器拥有的 DSH 提供方路由 |
| `sessionTiming` | `renewBeforeMs: 300000`、`pollMs: 60000`、`requestTimeoutMs: 10000` | 持久登录续期时间，单位毫秒；省略的字段使用默认值，所有值必须是计时器范围内的正整数 |
| `uploadSync` | — | 可选的聊天附件持久化后台同步；配置 `pollMs`、`chunkBytes` 和 `requestTimeoutMs` |

[Desktop 补丁](../../../apps/desktop-host/config/desktop.cordis.patch.yml)在设置 `DSH_MANAGED_BACKEND_URL` 时启用该路由，并读取 `user-session` Host 凭据记录。Desktop 登录从后端取得令牌，用户不需手动输入。插件挂载期间会拒绝调用其他模型提供方，Desktop 会选择登录用户获授权的第一个模型。禁用该插件行后恢复普通提供方路由；插件仍挂载但缺少托管令牌时请求直接失败。

`managedBackend.authorizeProvider(id)` 允许组织扩展插件注册模型 provider，释放返回的 disposer 后撤销。独立内网模型 bundle 使用此扩展，其他 provider 仍被拒绝。

### 后端 API

目录读取携带 `Authorization: Bearer <token>`。`GET {baseURL}/v1/models` 返回 `{ "models": [{ "id": "default", "name": "默认模型" }], "connection": { "api": "openai-completions", "baseURL": "...", "apiKey": "...", "expiresAt": "..." } }`。每个 id 唯一，数组只包含该令牌可用的模型。模型还可携带可选的 `contextWindow` 与 `maxOutputTokens`；省略其中一项的模型回退到路由自身的默认值，而不是后端未声明的容量。`connection` 块给出线路协议、端点，以及一个限定于获准模型的短时 Key；适配器把该 Key 直接发给该端点，因此生成不会回到后端，后端自身的上游凭据留在后端。适配器在每次调用前重新读取目录，因此轮换或过期的 `apiKey` 无需重启 DSH。401 表示身份无效；403 表示模型访问被拒绝。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

适配器在每次模型查询或请求准备时解析凭据。准备阶段把该令牌绑定到随后的生成请求，后端在发送时决定其是否仍有效。模型目录不来自 `settings.yaml`。配置后，[上传同步](src/upload-sync.ts)把已提交的聊天附件记入本地重试队列，重启后从后端确认的偏移继续上传。它只在源文件流中跳过这次启动时确认的偏移；后续分片确认只推进目标写入偏移，不再跳过源文件字节。适配器与协议解析位于 [src/index.ts](src/index.ts)；[适配器测试](tests/adapter.spec.ts)覆盖目录准入、后端撤权与流结束。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [LLM 适配器约定](../../../docs/subsystems/llm-streaming.zh.md)——请求与分片语义。
- [凭据](../../credentials/credentials/README.zh.md)——凭据引用与解析。
- [Desktop 应用](../../../apps/desktop/README.zh.md)——本地宿主组合。

-----

<a id="model-experience"></a>
## 模型体验

### 托管请求

#### 模型看到什么

后端接收已组装的 DSH `messages` 与 `tools` 字段。后端决定如何把这些字段送给所选上游模型；适配器不添加提示词文本。

#### Token 影响

后端负责分词并返回可用的用量分片。适配器不估算提供方专用的图片成本。

#### KV Cache 影响

后端负责上游缓存行为。DSH 正常保留已组装的请求历史并记录返回的分片。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- Desktop 登录通过 Host 凭据控制器取得用户令牌；其他 profile 必须通过自己的可信登录流程提供令牌。
- 后端 API 是 DSH 专用协议：后端必须返回获准目录，以及一个 Key 恰好限定于这些模型的连接。
- 生成直接发往该连接端点，因此该端点必须能从 DSH 宿主访问。
- 本地用户可以修改本地 DSH 安装。只有后端能够强制限制组织保管的提供方凭据和模型。
- 文件同步只扫描已提交的用户消息；后端确认完成前，本地队列会保存 prompt 和存储文件路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文 — 点击展开</summary>

无。

</details>

## 持久登录

AIGC 与 SSO 登录共用本机持久会话凭据，关闭程序不会清除。访问令牌即将过期或重启后按需自动续期；网络故障保留凭据，手动退出或会话撤销会清除。sessionTiming 可配置 renewBeforeMs、pollMs 和 requestTimeoutMs，默认分别为 300000、60000、10000 毫秒，均要求正整数。
