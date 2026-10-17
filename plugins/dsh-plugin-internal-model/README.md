# AIGC 内网模型直连插件

独立 DSH bundle，AIGC 负责插件启停及模型授权，DSH 直接调用内网 OpenAI-compatible Chat Completions 服务。兼容基础版本 `0.1.7-alpha.2`，需要包含本次 provider 扩展及请求传输更新的 DSH 构建。

## 配置与发布

1. 更新并部署本次 AIGC 服务端、门户和 DSH 客户端代码。
2. 在现有“模型管理”新增本地模型：模型标识 `MiniMax`、Base URL `https://aiplatform.boschhuayu-steering.com/v1`、Endpoint Path `/chat/completions`、认证方式 Bearer，密钥填入模型 API Key 字段。启用模型，按需开启工具调用并授予用户/角色/部门使用权限。
3. 在“插件管理”上传 `bhss-dsh-plugin-internal-model-1.0.6.tgz`，选择发布版本、启用并授权同一批使用者。无需填写博查密钥或复制模型 API Key。

4. 插件配置可保持 `{}`；如要调整容量和授权请求超时，可设置下面的 JSON：

```json
{"llm-internal-model":{"requestTimeoutMs":15000,"contextWindow":262144,"maxOutputTokens":32768}}
```

容量是未提供模型容量时的部署默认值，请按实际模型调整。模型管理的 Max Tokens 设置会作为调用的默认输出上限，用户显式调用参数优先。

5. DSH 登录后等待插件同步，市场提示需重启时重启客户端，在模型选择中选择“AIGC 内网模型”下的模型。首次同步前可能暂时无法使用默认本地模型。

## 实际路径

- `GET /v1/models` 的 `models` 只包含 LiteLLM 模型；`additionalModels` 仅用于登录状态和本地默认选择，不含连接参数或密钥。
- 插件通过 `GET /v1/plugins/internal-model/models` 读取获授权的本地模型，目录不含密钥。
- 每次生成前重新验证模型，并请求 `GET /v1/plugins/internal-model/models/{id}/connection`。后端检查用户会话、插件启用/发布/授权、模型启用和模型授权后，返回该模型的连接参数，响应为 `Cache-Control: no-store`。
- DSH 在本次 prepared call 内存中持有连接参数，直接向模型服务发送流式请求。AIGC 用户令牌只发送给 AIGC，内网模型 Key 只发送给该模型地址；授权和上游请求均拒绝重定向。
- LiteLLM 模型保持原路由。本地模型不申请 LiteLLM Virtual Key，也不经过 LiteLLM 预算控制；工具调用审计仍沿用现有 AIGC 审计链路。

## 限制

当前支持文本及工具调用；图像输入未开放。模型服务需兼容 OpenAI `/chat/completions` 和 SSE。非标准协议需要另加适配器，不会静默回退至 LiteLLM。支持 Bearer、自定义请求头和无需认证；供应商能力仍需现场联调。

禁用、撤权或登出会阻止下一次授权请求；已获准且正在进行的请求不强制终止。直接下发的是模型配置中的共享 API Key，不是 AIGC 签发的短时凭据；需要撤销已复制的 Key 时应在模型服务轮换。密钥不写入 bundle、插件策略缓存或模型目录。

## 构建与测试

在本目录运行 `node build.mjs`，随后 `npm pack --ignore-scripts`。测试位于宿主 `packages/llm/llm-managed-backend/tests/internal-model.spec.ts` 和 `loader-composition.spec.ts`，覆盖真实 Loader 注册/卸载、流式文本和工具调用、认证隔离、取消与撤权。AIGC HTTP 测试位于 `DshManagedHttpTests.cs`。

组织请求优先调用 DSH 的有效令牌解析器，支持持久登录自动续期；旧版 DSH 继续读取原凭据记录。此改动需重新构建并发布插件包后生效。


## 1.0.2：内网模型取消来源诊断

本插件独立于 DSH 内置 managed/LiteLLM 适配器；更新客户端不会自动替换已发布的插件。升级请上传 1.0.2，选择该版本发布并保留原启用配置和授权，等待客户端同步，必要时重启 Host。

增加 `llm-request-diagnostic` 与 `internal-model-request-diagnostic` 记录，后者明确区分调用方取消和 `timeoutSeconds` 整次请求截止。插件自身截止现在分类为 `TIMEOUT`，调用方取消仍保留 `ABORTED`；不改服务器下发的超时值，不自动扩大上下文或重试。

`timeoutSeconds` 是总耗时限制，即使流式数据持续到达也会触发。AIGC 当前源码从 Chat:TimeoutSeconds 配置下发该值，默认 90 秒；生产实际值仍需检查部署配置。日志中出现缺少 contextWindow 的压缩警告，不代表已经确认上下文超限。


## 1.0.4 超时与生成进展诊断

在 AIGC 插件管理上传本版本，选择发布版本 1.0.4，保留原授权与其他自定义配置，填入：

```json
{
  "llm-internal-model": {
    "generationTimeoutSeconds": 0,
    "streamIdleTimeoutSeconds": 300
  }
}
```

- generationTimeoutSeconds：单次生成总时限，0 表示关闭，正整数 1～3600 表示秒数。省略时继续使用 AIGC 下发值，兼容已有配置。
- streamIdleTimeoutSeconds：底层适配器连续没有流事件的等待时限，1～3600 秒，默认 300。首个事件之前的等待也受限制。它不等同于有效文本的等待时限；模型不断输出思考内容时仍可以继续运行。
- requestTimeoutMs：目录和授权请求超时，默认 15000 毫秒，与生成阶段分开。

客户端同步后按提示重启 Host，无需重建桌面安装包或修改 ConfigMap。关闭插件总时限不改变模型服务、网络代理自身限制；用户仍可手动停止生成。

internal-model-request-diagnostic 新增首个非空内容耗时 firstContentMs、最后非空内容距结束时间 lastContentAgoMs、text/reasoning/toolCall 分类事件计数 contentEvents、数值 token 用量 usage 和 finishReason。结束、usage、空 delta 不会刷新内容时间。成功、失败和消费者提前结束都会记录一次；不记录正文、思考文本、工具参数或密钥。

timeoutSeconds 记录最终总时限（0 表示关闭），streamIdleTimeoutSeconds 记录空闲时限；cancellationSource 区分 caller、internal-route-total-deadline、stream-idle-timeout 和 upstream-or-sdk，成功时为 null。日志中的事件计数不是 token 数，也不能证明模型输出内容正确。

验证：持续 SSE 超过原服务器总时限后正常完成；无总时限时停流仍触发空闲超时；关闭总时限后手动取消仍有效；已有正数覆盖和默认回退行为保留。未连接生产内网模型，需发布同步后现场验证。

## 1.0.5 上下文容量元数据修复

resolveModel 现在向宿主返回 context.contextWindow 和 defaultMaxTokens，使自动压力压缩能够读取容量并计算阈值。contextWindow 来自插件配置；输出上限优先采用 AIGC 模型管理的 Max Tokens，未设置时使用插件 maxOutputTokens。模型预检与实际请求使用相同元数据，每次重新检查授权，连接密钥不包含在返回的模型元数据中。

在 AIGC 上传并选择发布版本 1.0.5，保留 1.0.4 的超时设置和原授权，并将 contextWindow 配置为 vLLM 实际支持的上下文容量（max-model-len）；maxOutputTokens 或模型管理中的 Max Tokens 必须为容量留出输入与压缩余量。插件默认 contextWindow 为 262144，不代表部署模型实际具有该容量，不应盲目沿用。

客户端同步后按提示重启 Host，无需重新打包桌面程序。自动压缩仍受 DSH 的 auto 配置、历史长度阈值和摘要模型可用性影响，不是每次请求都会压缩。修复容量读取不保证摘要模型一定生成成功。

验证：通过真实 LlmRuntime 读取插件容量和服务端/插件两种输出上限，并检查 prepared call 一致性；内网模型与 compaction-basic 共 180 项测试通过。未连接生产模型验证自动摘要。

## 1.0.6 自动发现上下文容量

删除插件配置中的 contextWindow 即启用自动发现（不删除其他自定义项）：

```json
{"llm-internal-model":{"generationTimeoutSeconds":0,"streamIdleTimeoutSeconds":300}}
```

显式配置 contextWindow 仍优先，并跳过发现请求；旧配置中保留的 262144 也会被视为显式配置。新版移除了 schema 的固定容量默认值。

插件在获得 AIGC 当前授权连接后，向该连接 Base URL 下的 /models 发起 GET（例如 Base URL 为 https://gpu.example/v1，则查询 https://gpu.example/v1/models）。沿用该模型的 Bearer、自定义头或无认证方式，不发送 AIGC 用户令牌，拒绝重定向；超时使用 requestTimeoutMs，响应最大 4 MiB。

只接受 data 数组中 id 与实际 modelIdentifier 完全一致的唯一模型条目，读取其 max_model_len 正整数（1024～2000000）。不选择其他模型、不从名称猜测、不将 max_tokens 误认为总容量。模型元数据查询每次重新执行，不缓存容量或密钥。

若 GPUStack/代理不返回容量字段、找不到对应模型、请求失败或超时，返回 INVALID_MODEL_CONTEXT 并提示显式配置 contextWindow，阻止本次模型请求；不会继续使用未知容量。查询被用户取消时保持 ABORTED。配置容量与发现容量都将用于宿主压缩与底层调用。

internal-model-request-diagnostic 增加 contextWindow 与 contextWindowSource（plugin-config / models-api），用于确认容量来源。自动发现并不自动扩大模型输出预算：AIGC Max Tokens 或插件 maxOutputTokens 应小于容量，并留出输入与压缩余量。

上传并发布 1.0.6，让客户端同步并按提示重启 Host，无需重打包客户端或部署 AIGC。已通过精确匹配、认证隔离、显式配置优先、缺失/非法/重复容量、HTTP 错误、响应限额、查询超时与取消测试；内网模型和压缩模块共 192 项测试通过，完整 Host/Client 类型检查通过。生产 GPUStack 是否保留 max_model_len 尚未现场验证。
