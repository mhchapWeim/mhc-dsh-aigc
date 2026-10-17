using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

/// <summary>聊天模型的基础配置选项。</summary>
public sealed class ChatOptions
{
    public string BaseUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string Model { get; set; } = "";
    public int TimeoutSeconds { get; set; } = 90;
}

/// <summary>模型回复：可包含普通文本，也可包含一次工具调用及其参数。</summary>
public sealed record ChatModelResponse(string? Content, string? ToolName, JsonElement? ToolArguments,
    Guid? ModelId = null, string? ModelName = null);

/// <summary>负责解析模型配置、调用兼容聊天接口并转换模型响应。</summary>
public sealed class ChatModelClient(IHttpClientFactory clientFactory, ModelConfigurationService configurations)
{
    /// <summary>使用指定或默认模型完成一轮对话；未配置模型时返回明确提示。</summary>
    public async Task<ChatModelResponse> CompleteAsync(Guid userId, IReadOnlyList<ChatMessage> messages,
        IReadOnlyList<ChatToolDefinition> tools, Guid? modelId, CancellationToken ct)
    {
        var model = await configurations.ResolveGrantedAsync(userId, modelId, ct);
        if (model is null)
            return new ChatModelResponse("模型服务尚未配置。请联系平台管理员在“模型管理”中完成接入。", null, null);
        return await SendAsync(model, messages, tools, ct);
    }

    /// <summary>发送最小测试消息，验证指定模型配置能否正常返回内容。</summary>
    public async Task<string> TestAsync(Guid modelId, CancellationToken ct)
    {
        var model = await configurations.ResolveAsync(modelId, ct)
            ?? throw new WorkflowException("模型服务尚未配置");
        var reply = await SendAsync(model,
            [new ChatMessage { Role = "user", Content = "连接测试：请仅回复 OK。" }], [], ct);
        return $"连接成功，{model.Name} 返回：{reply.Content}";
    }

    /// <summary>构造请求、发送至模型服务，并解析文本回复或工具调用。</summary>
    private async Task<ChatModelResponse> SendAsync(ResolvedChatModel model,
        IReadOnlyList<ChatMessage> messages, IReadOnlyList<ChatToolDefinition> tools, CancellationToken ct)
    {
        // 根据模型配置拼接接口地址，并按认证类型注入密钥。
        var endpoint = $"{model.BaseUrl.TrimEnd('/')}/{model.EndpointPath.TrimStart('/')}";
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        if (!string.IsNullOrWhiteSpace(model.ApiKey))
        {
            if (model.AuthType == "Bearer") request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", model.ApiKey);
            else if (model.AuthType == "Header") request.Headers.TryAddWithoutValidation(model.ApiKeyHeader, model.ApiKey);
        }
        var payload = new Dictionary<string, object?>
        {
            // 系统提示约束工具调用和必填字段收集；历史消息随后一起传给模型。
            ["model"] = model.ModelIdentifier,
            ["messages"] = new object[]
            {
                new { role = "system", content = """
                    你是 BHSS AIGC Hub 助手。只能调用提供的工具，不得编造工具执行结果。
                    只向用户收集工具 JSON Schema 中 required 列出的业务字段；可选字段和有默认值的字段应直接省略，禁止要求用户补充。
                    当 required 字段齐全时立即调用工具，不要在回复中再次询问是否确认；写操作的最终确认由平台统一处理。
                    回复使用简洁、规范的 Markdown，表格仅在确实适合比较结构化数据时使用。
                    """ }
            }.Concat(messages.Select(x => (object)new { role = x.Role == "assistant" ? "assistant" : "user", content = x.Content })),
            ["temperature"] = model.Temperature,
            ["stream"] = false
        };
        if (model.MaxTokens.HasValue) payload["max_tokens"] = model.MaxTokens.Value;
        if (model.SupportsTools && tools.Count > 0)
        {
            // 只有模型支持工具且当前用户有可用工具时，才发送函数定义。
            payload["tools"] = tools.Select(x => new
            {
                type = "function",
                function = new { name = x.Name, description = x.Description, parameters = x.Parameters }
            });
            payload["tool_choice"] = "auto";
        }
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var http = clientFactory.CreateClient(model.ProviderKind == "LiteLLM" ? "litellm-chat" : "");
        http.Timeout = TimeSpan.FromSeconds(Math.Clamp(model.TimeoutSeconds, 10, 300));
        using var response = await http.SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        // 将模型侧 HTTP 错误或缺少 choices 的响应转换为平台可识别的异常。
        if (!response.IsSuccessStatusCode)
            throw new WorkflowException($"模型服务调用失败（{(int)response.StatusCode}）：{SafeError(raw)}", 502);
        using var document = JsonDocument.Parse(raw);
        if (!document.RootElement.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0)
            throw new WorkflowException("模型响应缺少 choices", 502);
        var message = choices[0].GetProperty("message");
        if (message.TryGetProperty("tool_calls", out var calls) && calls.GetArrayLength() > 0)
        {
            // 工具参数需要 Clone：离开 JsonDocument 的作用域后仍可由编排层读取。
            var function = calls[0].GetProperty("function");
            var name = function.GetProperty("name").GetString();
            var argsText = function.GetProperty("arguments").GetString() ?? "{}";
            using var args = JsonDocument.Parse(argsText);
            return new ChatModelResponse(null, name, args.RootElement.Clone(), model.Id, model.Name);
        }
        return new ChatModelResponse(message.TryGetProperty("content", out var content) ? content.GetString() : "未收到模型回复",
            null, null, model.Id, model.Name);
    }

    /// <summary>截断并清理模型错误正文，避免将过长响应直接返回给客户端。</summary>
    private static string SafeError(string raw)
    {
        var value = raw.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return value.Length > 240 ? value[..240] : value;
    }
}

/// <summary>编排用户消息、模型回复和企业工具的待确认或执行流程。</summary>
public sealed class ChatOrchestrator(AigcHubDbContext db, ChatToolRegistry registry,
    ChatToolExecutionService executions, ChatModelClient model)
{
    /// <summary>发送一轮消息；必要时创建会话、处理确认指令或向模型请求回复。</summary>
    public async Task<object> SendAsync(Guid userId, Guid? conversationId, string content, Guid? modelId, CancellationToken ct)
    {
        // 校验会话归属；首次发言创建会话，后续发言可更新该会话选用的模型。
        if (string.IsNullOrWhiteSpace(content)) throw new WorkflowException("消息不能为空");
        var conversation = conversationId.HasValue
            ? await db.ChatConversations.SingleOrDefaultAsync(x => x.Id == conversationId && x.UserId == userId, ct)
            : null;
        if (conversationId.HasValue && conversation is null) throw new WorkflowException("对话不存在", 404);
        if (conversation is null)
        {
            conversation = new ChatConversation
            {
                UserId = userId, ModelConfigurationId = modelId,
                Title = content.Trim().Length > 24 ? content.Trim()[..24] : content.Trim()
            };
            db.ChatConversations.Add(conversation);
        }
        else if (modelId.HasValue) conversation.ModelConfigurationId = modelId;
        conversation.UpdatedAt = DateTimeOffset.UtcNow;
        var userMessage = new ChatMessage { Conversation = conversation, Role = "user", Content = content.Trim() };
        db.ChatMessages.Add(userMessage);
        await db.SaveChangesAsync(ct);

        // 用户直接回复“确认”或“取消”时，优先处理本会话最新的待确认工具，而不再次调用模型。
        var pending = await db.ChatToolExecutions
            .Where(x => x.ConversationId == conversation.Id && x.UserId == userId
                && x.Status == ChatToolExecutionStatus.AwaitingConfirmation)
            .OrderByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        if (pending is not null && IsConfirmation(content))
        {
            // 取消较早的待确认提议，避免同一条确认指令触发多个写操作。
            var stalePending = await db.ChatToolExecutions
                .Where(x => x.ConversationId == conversation.Id && x.UserId == userId
                    && x.Status == ChatToolExecutionStatus.AwaitingConfirmation && x.Id != pending.Id)
                .ToListAsync(ct);
            foreach (var stale in stalePending)
            {
                stale.Status = ChatToolExecutionStatus.Cancelled;
                stale.CompletedAt = DateTimeOffset.UtcNow;
            }
            var updated = (ChatToolExecutionView)await executions.ConfirmAsync(userId, pending.Id, ct);
            // 记录真实执行结果作为助手消息，而非根据模型猜测执行是否成功。
            var result = string.IsNullOrWhiteSpace(pending.ResultJson)
                ? null
                : JsonSerializer.Deserialize<ChatToolResult>(pending.ResultJson);
            var confirmation = new ChatMessage
            {
                ConversationId = conversation.Id,
                Role = "assistant",
                Content = updated.Status == "Failed"
                    ? ToolExecutionMessage(updated)
                    : result?.Message ?? "操作已执行。"
            };
            db.ChatMessages.Add(confirmation);
            conversation.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return new
            {
                conversationId = conversation.Id,
                message = MessageView(confirmation),
                toolExecution = updated,
                modelConfigured = conversation.ModelConfigurationId.HasValue,
                modelId = conversation.ModelConfigurationId,
                modelName = (string?)null
            };
        }
        if (pending is not null && IsCancellation(content))
        {
            // 取消本会话所有待确认提议，并持久化取消消息。
            var pendingItems = await db.ChatToolExecutions
                .Where(x => x.ConversationId == conversation.Id && x.UserId == userId
                    && x.Status == ChatToolExecutionStatus.AwaitingConfirmation)
                .ToListAsync(ct);
            foreach (var item in pendingItems)
            {
                item.Status = ChatToolExecutionStatus.Cancelled;
                item.CompletedAt = DateTimeOffset.UtcNow;
            }
            await db.SaveChangesAsync(ct);
            var updated = ChatToolExecutionService.ViewForClient(pending, registry.Get(pending.ToolName).Definition);
            var cancellation = new ChatMessage
            {
                ConversationId = conversation.Id,
                Role = "assistant",
                Content = "已取消本次操作。"
            };
            db.ChatMessages.Add(cancellation);
            conversation.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return new
            {
                conversationId = conversation.Id,
                message = MessageView(cancellation),
                toolExecution = updated,
                modelConfigured = conversation.ModelConfigurationId.HasValue,
                modelId = conversation.ModelConfigurationId,
                modelName = (string?)null
            };
        }
        var requestedTool = ChatIntentRouter.ResolveToolName(content);
        if (pending is not null && requestedTool is not null
            && !pending.ToolName.Equals(requestedTool, StringComparison.OrdinalIgnoreCase))
        {
            // 明确切换到其他操作时撤销旧待办；后续“确认”不能再执行旧写操作。
            var stalePending = await db.ChatToolExecutions
                .Where(x => x.ConversationId == conversation.Id && x.UserId == userId
                    && x.Status == ChatToolExecutionStatus.AwaitingConfirmation)
                .ToListAsync(ct);
            foreach (var item in stalePending)
            {
                item.Status = ChatToolExecutionStatus.Cancelled;
                item.CompletedAt = DateTimeOffset.UtcNow;
            }
            await db.SaveChangesAsync(ct);
        }
        // 最近消息先按时间倒序截取，再恢复时间顺序传给模型；明确的新操作只需较短上下文。
        var namedApplication = requestedTool == "open_application"
            ? ChatIntentRouter.ExtractApplicationName(content) : null;
        var history = namedApplication is null
            ? await ChatContextSelector.LoadRecentAsync(db, conversation.Id,
                userMessage.Id, requestedTool is null ? 30 : 8, ct)
            : [userMessage];
        // 工具定义先按用户权限过滤，再传入模型，防止模型获得无权调用的工具。
        var available = await registry.AvailableAsync(userId, ct);
        if (requestedTool is not null)
        {
            // 对明确操作仅暴露匹配工具，避免模型把“打开应用”错误解释为创建分类。
            available = available.Where(x => x.Name.Equals(requestedTool, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (available.Count == 0)
                throw new WorkflowException("当前账号无权使用所请求的工具", 403);
        }
        var answer = await model.CompleteAsync(userId, history, available, conversation.ModelConfigurationId, ct);
        object? execution = null;
        string assistantContent;
        if (!string.IsNullOrWhiteSpace(answer.ToolName) && answer.ToolArguments.HasValue)
        {
            var definition = available.FirstOrDefault(x => x.Name.Equals(answer.ToolName, StringComparison.OrdinalIgnoreCase));
            if (definition is null)
                assistantContent = "模型返回了与当前请求不符的工具调用，平台已拦截，本次没有执行任何操作。";
            else if (namedApplication is not null
                && !ChatIntentRouter.MatchesApplicationName(namedApplication, answer.ToolArguments.Value))
                assistantContent = $"模型返回的应用名称与“{namedApplication}”不一致，平台已拦截，本次没有打开任何应用。";
            else
            {
                // 工具名称必须在当前请求允许的列表中，才能进入提议或实际执行阶段。
                var proposed = (ChatToolExecutionView)await executions.ProposeAsync(
                    userId, conversation.Id, definition.Name, answer.ToolArguments.Value, ct);
                execution = proposed;
                assistantContent = definition.RequiresConfirmation
                    ? BuildConfirmationPreview(definition, answer.ToolArguments.Value)
                    : ToolExecutionMessage(proposed);
            }
        }
        else assistantContent = requestedTool is null
            ? answer.Content ?? "未收到模型回复"
            : "模型未返回与当前请求匹配的工具调用，因此没有执行操作。请明确操作对象后重试。";
        var assistant = new ChatMessage { ConversationId = conversation.Id, Role = "assistant", Content = assistantContent };
        db.ChatMessages.Add(assistant);
        conversation.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return new { conversationId = conversation.Id, message = MessageView(assistant), toolExecution = execution,
            modelConfigured = answer.ModelId.HasValue, modelId = answer.ModelId, modelName = answer.ModelName };
    }

    /// <summary>将数据库消息转换为返回给前端的轻量视图。</summary>
    public static object MessageView(ChatMessage message) => new
    {
        message.Id, message.Role, message.Content, message.ToolExecutionId, message.CreatedAt
    };

    /// <summary>根据真实执行状态生成助手回复，不将失败误报为已提交或已完成。</summary>
    public static string ToolExecutionMessage(ChatToolExecutionView execution) => execution.Status switch
    {
        "Succeeded" => execution.Result?.Message ?? $"“{execution.DisplayName}”已执行。",
        "Failed" => $"“{execution.DisplayName}”失败：{execution.Error ?? "工具执行失败"}",
        "Running" => $"“{execution.DisplayName}”正在执行。",
        _ => $"“{execution.DisplayName}”未执行，请查看工具状态。"
    };

    /// <summary>为待确认工具生成包含业务参数和默认值的 Markdown 预览。</summary>
    public static string BuildConfirmationPreview(ChatToolDefinition definition, JsonElement arguments)
    {
        // 各类写操作使用面向用户的字段名称；未提供的可选参数展示平台默认值。
        var rows = definition.Name switch
        {
            "create_category" => new[]
            {
                ("分类名称", Value(arguments, "name", "未填写")),
                ("分类编码", Value(arguments, "code", "自动生成")),
                ("描述", Value(arguments, "description", "未填写")),
                ("主题色", Value(arguments, "color", "#2465d0（默认）")),
                ("排序", PositiveNumber(arguments, "sortOrder", "现有分类末尾（默认）")),
                ("状态", BooleanLabel(arguments, "isEnabled", "启用（默认）"))
            },
            "create_department" => new[]
            {
                ("部门名称", Value(arguments, "name", "未填写")),
                ("部门编码", Value(arguments, "code", "自动生成")),
                ("部门说明", Value(arguments, "description", "未填写")),
                ("部门负责人", Value(arguments, "managerId", "暂不指定")),
                ("状态", BooleanLabel(arguments, "isEnabled", "启用（默认）"))
            },
            "create_user" => new[]
            {
                ("姓名", Value(arguments, "name", "未填写")),
                ("工号", Value(arguments, "employeeNo", "未填写")),
                ("企业邮箱", Value(arguments, "email", "未填写")),
                ("部门", Value(arguments, "department", "未填写")),
                ("角色", Value(arguments, "roles", "未填写")),
                ("初始密码", "使用系统默认密码"),
                ("状态", BooleanLabel(arguments, "isEnabled", "启用（默认）"))
            },
            "create_publication_request" => new[]
            {
                ("应用名称", Value(arguments, "appName", "未填写")),
                ("分类", Value(arguments, "category", "未填写")),
                ("应用简介", Value(arguments, "summary", "未填写")),
                ("仓库地址", Value(arguments, "repositoryUrl", "未填写")),
                ("代码分支", Value(arguments, "branch", "main（默认）")),
                ("版本", Value(arguments, "version", "未填写")),
                ("部署环境", Value(arguments, "environment", "Production（默认）")),
                ("可访问范围", Value(arguments, "accessMode", "所有已登录用户（默认）"))
            },
            _ => arguments.ValueKind == JsonValueKind.Object
                ? arguments.EnumerateObject().Select(property =>
                    (ParameterLabel(property.Name), IsSensitive(property.Name) ? "******" : Display(property.Value))).ToArray()
                : [("参数", Display(arguments))]
        };
        var table = string.Join("\n", rows.Select(row => $"| {EscapeCell(row.Item1)} | {EscapeCell(row.Item2)} |"));
        return $"""
            ### 请确认{definition.DisplayName}

            | 参数 | 将要使用的值 |
            | --- | --- |
            {table}

            > 确认无误后，回复“确认”或点击下方的“确认执行”；如需修改，直接告诉我新的参数。
            """;
    }

    /// <summary>读取非空参数，缺省时返回展示用的默认说明。</summary>
    private static string Value(JsonElement arguments, string name, string fallback) =>
        TryProperty(arguments, name, out var value) && value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined
            && !string.IsNullOrWhiteSpace(Display(value)) ? Display(value) : fallback;

    /// <summary>仅展示有效的正整数，否则使用默认说明。</summary>
    private static string PositiveNumber(JsonElement arguments, string name, string fallback) =>
        TryProperty(arguments, name, out var value) && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var number) && number > 0
            ? number.ToString() : fallback;

    /// <summary>将布尔参数转换为用户可读的启用状态。</summary>
    private static string BooleanLabel(JsonElement arguments, string name, string fallback) =>
        TryProperty(arguments, name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean() ? "启用" : "停用"
            : fallback;

    /// <summary>不区分大小写地读取工具参数对象中的指定字段。</summary>
    private static bool TryProperty(JsonElement arguments, string name, out JsonElement value)
    {
        if (arguments.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in arguments.EnumerateObject())
            {
                if (!property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) continue;
                value = property.Value;
                return true;
            }
        }
        value = default;
        return false;
    }

    /// <summary>将 JSON 值转换为适合确认预览的文本。</summary>
    private static string Display(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.True => "是",
        JsonValueKind.False => "否",
        JsonValueKind.Array => string.Join("、", value.EnumerateArray().Select(Display)),
        JsonValueKind.Object => value.GetRawText(),
        JsonValueKind.Null or JsonValueKind.Undefined => "",
        _ => value.GetRawText()
    };

    /// <summary>为通用工具参数提供常见字段的中文标签。</summary>
    private static string ParameterLabel(string name) => name switch
    {
        "name" => "名称", "code" => "编码", "description" => "描述", "color" => "主题色",
        "sortOrder" => "排序", "isEnabled" => "状态", _ => name
    };

    /// <summary>识别不应在确认预览中明文展示的敏感字段。</summary>
    private static bool IsSensitive(string name) =>
        name.Contains("password", StringComparison.OrdinalIgnoreCase)
        || name.Contains("secret", StringComparison.OrdinalIgnoreCase)
        || name.Contains("token", StringComparison.OrdinalIgnoreCase)
        || name.Contains("apiKey", StringComparison.OrdinalIgnoreCase);

    /// <summary>转义 Markdown 表格单元格中的竖线和换行。</summary>
    private static string EscapeCell(string value) =>
        value.Replace("|", "\\|", StringComparison.Ordinal).Replace("\r\n", "<br />", StringComparison.Ordinal)
            .Replace("\n", "<br />", StringComparison.Ordinal);

    /// <summary>识别用户明确表达执行意愿的简短回复。</summary>
    private static bool IsConfirmation(string content) =>
        new[] { "确认", "确认执行", "同意", "执行", "可以", "好的", "是" }
            .Contains(content.Trim().TrimEnd('。', '！', '!'), StringComparer.OrdinalIgnoreCase);

    /// <summary>识别用户明确表达取消意愿的简短回复。</summary>
    private static bool IsCancellation(string content) =>
        new[] { "取消", "取消执行", "不同意", "不要执行", "否" }
            .Contains(content.Trim().TrimEnd('。', '！', '!'), StringComparer.OrdinalIgnoreCase);
}

/// <summary>从数据库读取最近的对话消息，同时保证本轮用户消息不会被截断。</summary>
public static class ChatContextSelector
{
    public static async Task<IReadOnlyList<ChatMessage>> LoadRecentAsync(AigcHubDbContext db,
        Guid conversationId, Guid currentMessageId, int limit, CancellationToken ct)
    {
        var recent = await db.ChatMessages.AsNoTracking()
            .Where(x => x.ConversationId == conversationId && x.Role != "tool")
            .OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id)
            .Take(limit).ToListAsync(ct);
        var current = recent.FirstOrDefault(x => x.Id == currentMessageId);
        if (current is null)
        {
            current = await db.ChatMessages.AsNoTracking()
                .SingleAsync(x => x.Id == currentMessageId && x.ConversationId == conversationId, ct);
            if (recent.Count >= limit) recent.RemoveAt(recent.Count - 1);
        }
        // 时间戳并列时仍强制把本轮用户消息放在最后，避免模型误把旧请求当成当前请求。
        return recent.Where(x => x.Id != currentMessageId)
            .OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Append(current).ToArray();
    }
}

/// <summary>识别用户明确提出的企业工具操作；模糊提问仍由模型正常理解。</summary>
public static class ChatIntentRouter
{
    private static readonly Regex OpenVerb = new(@"^(?:请|麻烦)?(?:帮我|给我)?(?:打开|访问|进入|启动)\s*.+",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CreateVerb = new(@"(?:创建|新建|添加|增加)", RegexOptions.Compiled);
    private static readonly Regex NamedApplication = new(
        @"^(?:请|麻烦)?(?:帮我|给我)?(?:打开|访问|进入|启动)\s*(?<name>.+?)\s*(?:这个)?(?:应用|app)\s*[。！!]?\s*$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static string? ResolveToolName(string content)
    {
        var value = content.Trim();
        if (value.Contains("如何", StringComparison.Ordinal) || value.Contains("怎么", StringComparison.Ordinal)) return null;
        if (OpenVerb.IsMatch(value) && (value.Contains("应用", StringComparison.Ordinal)
            || value.Contains("app", StringComparison.OrdinalIgnoreCase))) return "open_application";
        if (!CreateVerb.IsMatch(value)) return null;
        if (value.Contains("发布申请", StringComparison.Ordinal) || value.Contains("应用发布", StringComparison.Ordinal))
            return "create_publication_request";
        if (value.Contains("分类", StringComparison.Ordinal) || value.Contains("类别", StringComparison.Ordinal))
            return "create_category";
        if (value.Contains("部门", StringComparison.Ordinal)) return "create_department";
        if (value.Contains("用户", StringComparison.Ordinal) || value.Contains("账号", StringComparison.Ordinal))
            return "create_user";
        return null;
    }

    /// <summary>从明确的打开指令中提取应用名称；模糊指代交由模型结合上下文处理。</summary>
    public static string? ExtractApplicationName(string content)
    {
        var match = NamedApplication.Match(content.Trim());
        if (!match.Success) return null;
        var name = match.Groups["name"].Value.Trim().Trim('“', '”', '\'', '"', ' ', '　');
        return name is "" or "某个" or "这个" or "那个" or "刚才的" ? null : name;
    }

    /// <summary>自动打开应用前确认模型参数中的名称与用户明确指定的目标一致。</summary>
    public static bool MatchesApplicationName(string expected, JsonElement arguments)
    {
        if (arguments.ValueKind != JsonValueKind.Object) return false;
        foreach (var property in arguments.EnumerateObject())
        {
            if (!property.Name.Equals("applicationName", StringComparison.OrdinalIgnoreCase)
                || property.Value.ValueKind != JsonValueKind.String) continue;
            return expected.Equals(property.Value.GetString()?.Trim(), StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }
}
