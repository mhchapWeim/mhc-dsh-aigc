# AIGC 调用 LiteLLM 接口清单

核对日期：2026-10-21。

本清单依据当前工作区源码整理，不代表线上已部署版本或实际请求日志。接口路径中的 `/v1` 取决于具体调用处的 URL 拼接方式，详见下文。

## 接口清单

| 方法 | LiteLLM 接口 | AIGC 中的用途 | 认证凭据 |
|---|---|---|---|
| GET | `/v1/models` | 同步模型目录；查询虚拟 Key 策略中的可选模型 | 同步使用 `LiteLlm:ApiKey`；策略选项查询使用 `LiteLlm:ManagementApiKey` |
| GET | `/model/info` | 获取图片理解能力、上下文长度、最大输出和其他上游披露能力 | `LiteLlm:ManagementApiKey` |
| POST | `/key/generate` | 创建虚拟 Key，可带模型范围、预算、限流和有效期 | `LiteLlm:ManagementApiKey` |
| GET | `/key/info?key=<Key的SHA256>` | 查询虚拟 Key 的模型范围、预算、限流和有效期 | `LiteLlm:ManagementApiKey` |
| POST | `/key/update` | 修改虚拟 Key 的模型范围、预算、限流或有效期 | `LiteLlm:ManagementApiKey` |
| POST | `/key/block` | 停用虚拟 Key | `LiteLlm:ManagementApiKey` |
| POST | `/key/unblock` | 启用虚拟 Key | `LiteLlm:ManagementApiKey` |
| POST | `/v1/chat/completions` | 中台 Chat 对话、模型连接测试，以及后端 `/v1/generate` 的上游调用 | 对应模型配置中保存的 API Key，按配置使用 Bearer 或自定义请求头 |

聊天接口在源码中由模型的 `BaseUrl + EndpointPath` 动态组成；表中列出的是标准 OpenAI 兼容路径。若管理员配置其他路径，实际请求也会随之改变。

## 地址与凭据来源

### 模型目录同步

```text
请求地址 = LiteLlm:BaseUrl 去掉末尾斜杠 + /models
认证头   = Authorization: Bearer <LiteLlm:ApiKey>
```

例如 BaseUrl 为 `https://<LiteLLM入口>/v1` 时，最终请求为 `https://<LiteLLM入口>/v1/models`。未配置 ApiKey 时，代码不添加 Authorization 头；是否允许请求由上游决定。

### 能力查询和虚拟 Key 管理

```text
管理根地址 = LiteLlm:BaseUrl 去掉末尾斜杠，再去掉末尾 /v1
请求地址   = 管理根地址 + 管理接口路径
认证头     = Authorization: Bearer <LiteLlm:ManagementApiKey>
```

能力查询使用 `/model/info`；Key 策略可选模型使用 `/v1/models`；Key 管理使用 `/key/...`。`/key/info` 查询参数传入的是 Key 的 SHA256，不是明文 Key。

### 中台聊天和模型测试

```text
请求地址 = 模型 BaseUrl 去掉末尾斜杠 + / + EndpointPath 去掉开头斜杠
模型标识 = 模型配置的 ModelIdentifier
认证凭据 = 模型配置中保存的 API Key
```

`ChatModelClient` 的聊天和连接测试请求设置 `stream: false`。

## 与 DSH 客户端调用的区别

当前 DSH 托管 LiteLLM 适配器先向 AIGC 的 `/v1/models` 获取授权模型目录、连接地址和获授权的虚拟 Key，再由 DSH Host 发起推理请求。

```text
DSH Host → AIGC /v1/models
         ← 模型目录、LiteLlm:PublicBaseUrl、获授权的虚拟 Key

DSH Host → LiteLLM 入口 /v1/chat/completions → 实际模型服务
```

这里的“LiteLLM 入口”可以是 Nginx 反向代理。DSH 托管推理使用 `LiteLlm:PublicBaseUrl`，并使用虚拟 Key；它不使用 AIGC 登录令牌作为 LiteLLM 密钥，也不通过 AIGC `/v1/generate` 转发普通托管推理。

## 反向代理放行范围

| 调用方 | 需要访问的接口 |
|---|---|
| AIGC 后端 | 模型目录、能力查询、Key 管理，以及实际配置的聊天接口 |
| DSH 普通托管推理 | `/v1/chat/completions` |

Key 管理接口应仅向 AIGC 后端及授权运维入口开放，客户端推理入口无需暴露 `/key/*`。域名、端口和网络可达性需要以现场配置为准。

## 源码位置

- 模型同步：`server/AigcHub.Api/Services/LiteLlmModelSyncService.cs`
- 能力查询、虚拟 Key 创建及启停：`server/AigcHub.Api/Services/LiteLlmVirtualKeyService.cs`
- 虚拟 Key 策略查询与更新：`server/AigcHub.Api/Services/VirtualKeyPolicy.cs`
- 中台聊天及连接测试：`server/AigcHub.Api/Services/ChatServices.cs`
- DSH 目录下发及后端生成接口：`server/AigcHub.Api/Endpoints/DshManagedEndpoints.cs`
- DSH 托管直连适配器：`deepseek-harness/packages/llm/llm-managed-backend/src/index.ts`
