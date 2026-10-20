using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

/// <summary>工具元数据：名称、所需权限、确认要求及传给模型的参数结构。</summary>
public sealed record ChatToolDefinition(
    string Name,
    string DisplayName,
    string Description,
    string RequiredPermission,
    bool RequiresConfirmation,
    JsonElement Parameters);

/// <summary>工具执行结果，可携带业务数据或安全跳转地址。</summary>
public sealed record ChatToolResult(string Message, object? Data = null, string? NavigationUrl = null);

/// <summary>发送给前端的工具执行视图，保留实际状态和错误供对话编排层判断。</summary>
public sealed record ChatToolExecutionView(Guid Id, string ToolName, string DisplayName, object? Arguments,
    string Status, bool RequiresConfirmation, ChatToolResult? Result, string? Error,
    DateTimeOffset CreatedAt, DateTimeOffset? CompletedAt);

/// <summary>所有企业聊天工具实现的统一接口。</summary>
public interface IChatTool
{
    /// <summary>供注册表和模型使用的工具定义。</summary>
    ChatToolDefinition Definition { get; }
    /// <summary>以当前用户身份执行工具，业务参数由调用方校验和传入。</summary>
    Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct);
}

/// <summary>从数据库角色与权限关联中获取用户的实时权限。</summary>
public sealed class DatabasePermissionService(AigcHubDbContext db)
{
    /// <summary>返回已启用用户通过所有角色获得的权限编码集合。</summary>
    public async Task<HashSet<string>> GetPermissionsAsync(Guid userId, CancellationToken ct)
    {
        // 用户被停用或不存在时返回空集合；角色权限直接取自数据库，不依赖前端缓存。
        var user = await db.Users.AsNoTracking()
            .Include(x => x.Roles).ThenInclude(x => x.Role)
            .ThenInclude(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleOrDefaultAsync(x => x.Id == userId && x.IsEnabled, ct);
        return user is null
            ? []
            : user.Roles.SelectMany(x => x.Role.Permissions)
                .Select(x => x.Permission.Code).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>要求当前用户拥有指定权限，否则返回禁止访问错误。</summary>
    public async Task RequireAsync(Guid userId, string permission, CancellationToken ct)
    {
        if (!(await GetPermissionsAsync(userId, ct)).Contains(permission))
            throw new WorkflowException($"当前账号缺少 {permission} 权限", 403);
    }
}

/// <summary>按名称登记工具，并按用户权限筛选可暴露给模型的定义。</summary>
public sealed class ChatToolRegistry(IEnumerable<IChatTool> tools, DatabasePermissionService permissions)
{
    // 工具名称不区分大小写，模型返回的名称可直接定位到对应实现。
    private readonly IReadOnlyDictionary<string, IChatTool> _tools = tools.ToDictionary(
        x => x.Definition.Name, StringComparer.OrdinalIgnoreCase);

    /// <summary>列出当前用户有权使用的工具定义。</summary>
    public async Task<IReadOnlyList<ChatToolDefinition>> AvailableAsync(Guid userId, CancellationToken ct)
    {
        var granted = await permissions.GetPermissionsAsync(userId, ct);
        return _tools.Values.Where(x => granted.Contains(x.Definition.RequiredPermission))
            .Select(x => x.Definition).OrderBy(x => x.DisplayName).ToArray();
    }

    /// <summary>按名称取得工具实现；未知工具返回不存在错误。</summary>
    public IChatTool Get(string name) => _tools.TryGetValue(name, out var tool)
        ? tool
        : throw new WorkflowException("工具不存在或未启用", 404);
}

/// <summary>管理工具执行提议、用户确认、取消、状态持久化及操作审计。</summary>
public sealed class ChatToolExecutionService(
    AigcHubDbContext db,
    ChatToolRegistry registry,
    DatabasePermissionService permissions)
{
    /// <summary>返回当前用户会话中最新的一条待确认提议，用于刷新后恢复交互卡片。</summary>
    public async Task<IReadOnlyList<object>> ListPendingAsync(Guid userId, Guid conversationId, CancellationToken ct)
    {
        // 查询待办前先校验会话所有权，避免读取其他用户的工具参数。
        if (!await db.ChatConversations.AsNoTracking().AnyAsync(
                x => x.Id == conversationId && x.UserId == userId, ct))
            throw new WorkflowException("对话不存在", 404);
        var items = await db.ChatToolExecutions.AsNoTracking()
            .Where(x => x.ConversationId == conversationId && x.UserId == userId
                && x.Status == ChatToolExecutionStatus.AwaitingConfirmation)
            .OrderByDescending(x => x.CreatedAt)
            .Take(1)
            .ToListAsync(ct);
        return items.Select(item => View(item, registry.Get(item.ToolName).Definition)).ToArray();
    }

    /// <summary>创建工具执行提议；写操作进入待确认状态，免确认工具立即执行。</summary>
    public async Task<object> ProposeAsync(Guid userId, Guid conversationId, string toolName,
        JsonElement arguments, CancellationToken ct)
    {
        // 校验会话归属、工具存在性和实时权限，不能只信任模型传来的工具名称。
        var conversationExists = await db.ChatConversations.AnyAsync(
            x => x.Id == conversationId && x.UserId == userId, ct);
        if (!conversationExists) throw new WorkflowException("对话不存在", 404);
        var tool = registry.Get(toolName);
        await permissions.RequireAsync(userId, tool.Definition.RequiredPermission, ct);
        var superseded = await db.ChatToolExecutions.Where(x => x.ConversationId == conversationId
            && x.UserId == userId && x.Status == ChatToolExecutionStatus.AwaitingConfirmation).ToListAsync(ct);
        // 新提议替换同会话旧提议，确保一次确认最多对应一个待执行动作。
        foreach (var item in superseded)
        {
            item.Status = ChatToolExecutionStatus.Cancelled;
            item.CompletedAt = DateTimeOffset.UtcNow;
        }
        var execution = new ChatToolExecution
        {
            ConversationId = conversationId,
            UserId = userId,
            ToolName = tool.Definition.Name,
            ArgumentsJson = arguments.GetRawText(),
            RequiresConfirmation = tool.Definition.RequiresConfirmation,
            Status = tool.Definition.RequiresConfirmation
                ? ChatToolExecutionStatus.AwaitingConfirmation
                : ChatToolExecutionStatus.Running
        };
        db.ChatToolExecutions.Add(execution);
        await db.SaveChangesAsync(ct);
        // 需确认的工具到此结束；只有免确认工具才会直接进入实际执行阶段。
        if (!execution.RequiresConfirmation)
            await ExecuteAsync(execution, tool, ct);
        return View(execution, tool.Definition);
    }

    /// <summary>确认待办提议并执行工具；再次检查归属、状态及当前权限。</summary>
    public async Task<object> ConfirmAsync(Guid userId, Guid executionId, CancellationToken ct)
    {
        // 权限可能在提议后发生变化，因此确认时必须重新鉴权。
        var execution = await db.ChatToolExecutions.SingleOrDefaultAsync(
            x => x.Id == executionId && x.UserId == userId, ct)
            ?? throw new WorkflowException("工具调用不存在", 404);
        if (execution.Status != ChatToolExecutionStatus.AwaitingConfirmation)
            throw new WorkflowException("工具调用已经处理", 409);
        var tool = registry.Get(execution.ToolName);
        await permissions.RequireAsync(userId, tool.Definition.RequiredPermission, ct);
        execution.ConfirmedAt = DateTimeOffset.UtcNow;
        execution.Status = ChatToolExecutionStatus.Running;
        await db.SaveChangesAsync(ct);
        // 先持久化“运行中”再执行，成功或失败的最终状态由执行方法记录。
        await ExecuteAsync(execution, tool, ct);
        return View(execution, tool.Definition);
    }

    /// <summary>将当前用户尚未执行的提议标记为已取消。</summary>
    public async Task<object> CancelAsync(Guid userId, Guid executionId, CancellationToken ct)
    {
        var execution = await db.ChatToolExecutions.SingleOrDefaultAsync(
            x => x.Id == executionId && x.UserId == userId, ct)
            ?? throw new WorkflowException("工具调用不存在", 404);
        if (execution.Status != ChatToolExecutionStatus.AwaitingConfirmation)
            throw new WorkflowException("工具调用已经处理", 409);
        execution.Status = ChatToolExecutionStatus.Cancelled;
        execution.CompletedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return View(execution, registry.Get(execution.ToolName).Definition);
    }

    /// <summary>实际执行工具，并统一记录结果消息、脱敏审计及失败状态。</summary>
    private async Task ExecuteAsync(ChatToolExecution execution, IChatTool tool, CancellationToken ct)
    {
        try
        {
            // 执行前第三次按数据库权限核对，避免在等待确认期间权限已被收回。
            await permissions.RequireAsync(execution.UserId, tool.Definition.RequiredPermission, ct);
            using var document = JsonDocument.Parse(execution.ArgumentsJson);
            var result = await tool.ExecuteAsync(execution.UserId, document.RootElement, ct);
            execution.ResultJson = JsonSerializer.Serialize(result);
            execution.Status = ChatToolExecutionStatus.Succeeded;
            execution.CompletedAt = DateTimeOffset.UtcNow;
            // 审计记录只保存脱敏参数，工具结果作为 tool 角色消息归入该会话。
            db.OperationAudits.Add(new OperationAudit
            {
                UserId = execution.UserId,
                Action = execution.ToolName,
                EntityType = "ChatTool",
                EntityId = execution.Id.ToString(),
                DetailJson = JsonSerializer.Serialize(new
                {
                    Arguments = RedactArguments(execution.ArgumentsJson),
                    result.Message
                }),
                Succeeded = true
            });
            db.ChatMessages.Add(new ChatMessage
            {
                ConversationId = execution.ConversationId,
                Role = "tool",
                Content = result.Message,
                ToolExecutionId = execution.Id
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            // 工具异常统一落库为失败状态，便于客户端展示和后续审计追踪。
            execution.Status = ChatToolExecutionStatus.Failed;
            execution.Error = ex.Message;
            execution.CompletedAt = DateTimeOffset.UtcNow;
            db.OperationAudits.Add(new OperationAudit
            {
                UserId = execution.UserId,
                Action = execution.ToolName,
                EntityType = "ChatTool",
                EntityId = execution.Id.ToString(),
                DetailJson = "{}",
                Succeeded = false
            });
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>将数据库中的执行记录转换为前端可展示的视图。</summary>
    internal static object ViewForClient(ChatToolExecution value, ChatToolDefinition definition) => View(value, definition);

    /// <summary>返回脱敏参数、状态及已完成的工具结果。</summary>
    private static ChatToolExecutionView View(ChatToolExecution value, ChatToolDefinition definition)
    {
        ChatToolResult? result = null;
        if (!string.IsNullOrWhiteSpace(value.ResultJson))
            result = JsonSerializer.Deserialize<ChatToolResult>(value.ResultJson);
        return new ChatToolExecutionView(value.Id, value.ToolName, definition.DisplayName,
            RedactArguments(value.ArgumentsJson), value.Status.ToString(), value.RequiresConfirmation,
            result, value.Error, value.CreatedAt, value.CompletedAt);
    }

    /// <summary>解析并脱敏原始 JSON 参数，不直接向客户端或审计日志暴露密钥。</summary>
    private static object? RedactArguments(string json)
    {
        using var document = JsonDocument.Parse(json);
        return RedactElement(document.RootElement);
    }

    /// <summary>递归处理对象和数组，保留普通值并遮盖敏感字段。</summary>
    private static object? RedactElement(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject().ToDictionary(
            property => property.Name,
            property => IsSensitive(property.Name) ? (object)"******" : RedactElement(property.Value)),
        JsonValueKind.Array => element.EnumerateArray().Select(RedactElement).ToArray(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.Number when element.TryGetInt64(out var integer) => integer,
        JsonValueKind.Number => element.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null
    };

    /// <summary>按字段名识别密码、令牌和密钥等敏感参数。</summary>
    private static bool IsSensitive(string name) =>
        name.Contains("password", StringComparison.OrdinalIgnoreCase)
        || name.Contains("secret", StringComparison.OrdinalIgnoreCase)
        || name.Contains("token", StringComparison.OrdinalIgnoreCase)
        || name.Contains("apiKey", StringComparison.OrdinalIgnoreCase);
}

/// <summary>工具参数的 JSON 反序列化和 Schema 生成辅助方法。</summary>
internal static class ToolJson
{
    /// <summary>不区分属性名大小写地读取工具参数。</summary>
    public static T Read<T>(JsonElement element) where T : class =>
        JsonSerializer.Deserialize<T>(element.GetRawText(), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? throw new WorkflowException("工具参数不能为空");

    /// <summary>将匿名对象形式的工具结构转换为 JSON Schema 元素。</summary>
    public static JsonElement Schema(object value) => JsonSerializer.SerializeToElement(value);
}

/// <summary>查找已上架应用，并在验证访问范围后返回可打开的地址。</summary>
public sealed class OpenApplicationTool(AigcHubDbContext db) : IChatTool
{
    private sealed record Arguments(Guid? ApplicationId, string? ApplicationName);
    /// <summary>打开应用工具的名称、权限与参数定义。</summary>
    public ChatToolDefinition Definition { get; } = new(
        "open_application", "打开应用", "打开当前用户有权访问的已上架应用", "portal.view", false,
        ToolJson.Schema(new { type = "object", properties = new { applicationId = new { type = "string" }, applicationName = new { type = "string" } } }));

    /// <summary>按应用 ID 或名称查找已发布应用，校验当前用户访问权限并返回 URL。</summary>
    public async Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct)
    {
        // 仅启用用户可打开应用；待查应用必须已通过发布审核且存在访问地址。
        var input = ToolJson.Read<Arguments>(arguments);
        var user = await db.Users.AsNoTracking().Include(x => x.Department)
            .Include(x => x.Roles).SingleOrDefaultAsync(x => x.Id == userId && x.IsEnabled, ct)
            ?? throw new WorkflowException("当前用户不存在或已停用", 403);
        var query = db.PublicationRequests.AsNoTracking().Include(x => x.AccessGrants)
            .Where(x => x.Status == PublicationStatus.Approved && x.AccessUrl != "");
        if (input.ApplicationId.HasValue) query = query.Where(x => x.Id == input.ApplicationId);
        else if (!string.IsNullOrWhiteSpace(input.ApplicationName))
            query = query.Where(x => x.AppName.ToLower() == input.ApplicationName.Trim().ToLower());
        else throw new WorkflowException("请选择要打开的应用");
        var matches = await query.Take(2).ToListAsync(ct);
        if (matches.Count == 0) throw new WorkflowException("没有找到已上架的应用", 404);
        if (matches.Count > 1) throw new WorkflowException("找到多个同名应用，请使用应用 ID");
        var app = matches[0];
        // All 范围直接放行；指定范围按用户、部门和角色授权逐项判断。
        var roleIds = user.Roles.Select(x => x.RoleId).ToHashSet();
        var allowed = app.AccessMode.Equals("All", StringComparison.OrdinalIgnoreCase)
            || app.AccessGrants.Any(x => x.SubjectType == "User" && x.SubjectId == user.Id)
            || app.AccessGrants.Any(x => x.SubjectType == "Department" && x.SubjectId == user.DepartmentId)
            || app.AccessGrants.Any(x => x.SubjectType == "Role" && roleIds.Contains(x.SubjectId));
        if (!allowed) throw new WorkflowException("当前账号不在该应用的可访问范围内", 403);
        // 外部跳转仅接受绝对 HTTPS 地址，避免返回无效或不安全的链接。
        if (!Uri.TryCreate(app.AccessUrl, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps)
            throw new WorkflowException("应用访问地址无效", 409);
        return new ChatToolResult($"正在打开“{app.AppName}”", new { app.Id, app.AppName }, url.ToString());
    }
}

/// <summary>从聊天工具创建发布申请，并交给流程服务启动审批。</summary>
public sealed class CreatePublicationRequestTool(
    AigcHubDbContext db,
    WorkflowService workflow) : IChatTool
{
    private sealed record Arguments(string AppName, string Category, string Summary, string RepositoryUrl,
        string Branch, string CommitSha, string Version, string Environment, string AccessMode,
        AccessSubjectRequest[]? AccessSubjects);
    /// <summary>发布申请工具的必填字段和确认要求。</summary>
    public ChatToolDefinition Definition { get; } = new(
        "create_publication_request", "新建发布申请", "创建应用发布申请并启动审批流程", "publication.create", true,
        ToolJson.Schema(new
        {
            type = "object",
            properties = new
            {
                appName = new { type = "string", description = "应用名称" },
                category = new { type = "string", description = "分类 ID、编码或名称" },
                summary = new { type = "string", description = "应用简介" },
                repositoryUrl = new { type = "string", description = "代码仓库 HTTPS 地址" },
                branch = new { type = "string", description = "分支" },
                commitSha = new { type = "string", description = "待审核提交 SHA" },
                version = new { type = "string", description = "发布版本" },
                environment = new { type = "string", @enum = new[] { "Test", "Staging", "Production" } },
                accessMode = new { type = "string", @enum = new[] { "All", "Subjects" } },
                accessSubjects = new { type = "array", description = "可访问人员、部门或角色" }
            },
            @required = new[] { "appName", "category", "summary", "repositoryUrl", "branch", "commitSha", "version", "environment", "accessMode" }
        }));

    /// <summary>解析分类并提交发布申请，返回申请编号和当前审批节点。</summary>
    public async Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct)
    {
        // 分类可使用 ID、编码或名称输入，但必须是当前启用的真实分类。
        var input = ToolJson.Read<Arguments>(arguments);
        var categoryItems = await db.Categories.Where(x => x.IsEnabled).ToListAsync(ct);
        var category = categoryItems.FirstOrDefault(x => x.Id.ToString() == input.Category || x.Name.Equals(input.Category, StringComparison.OrdinalIgnoreCase) || x.Code.Equals(input.Category, StringComparison.OrdinalIgnoreCase))
            ?? throw new WorkflowException("应用分类不存在或已停用");
        // 申请保存及审批流启动由 WorkflowService 负责，不在工具中复制流程逻辑。
        var request = await workflow.SubmitAsync(userId, new SubmitPublicationRequest(
            input.AppName, category.Id, input.Summary, null, input.RepositoryUrl, input.Branch,
            input.CommitSha, input.Version, input.Environment, input.AccessMode, input.AccessSubjects), ct);
        return new ChatToolResult($"发布申请 {request.RequestNo} 已创建并进入“{request.CurrentNodeName}”", new { request.Id, request.RequestNo });
    }
}

/// <summary>创建企业用户，将其绑定部门和角色并安全生成密码哈希。</summary>
public sealed class CreateUserTool(
    AigcHubDbContext db,
    IPasswordHasher<AppUser> hasher) : IChatTool
{
    private sealed record Arguments(string EmployeeNo, string Name, string Email, string? Department,
        string[] Roles, string? InitialPassword, bool IsEnabled = true);
    /// <summary>新建用户工具的必填字段及权限定义。</summary>
    public ChatToolDefinition Definition { get; } = new(
        "create_user", "新建用户", "创建企业用户并分配部门和角色", "user.manage", true,
        ToolJson.Schema(new
        {
            type = "object",
            properties = new
            {
                employeeNo = new { type = "string" }, name = new { type = "string" }, email = new { type = "string" },
                department = new { type = "string", description = "部门 ID、编码或名称" },
                roles = new { type = "array", items = new { type = "string" } },
                initialPassword = new { type = "string" }, isEnabled = new { type = "boolean" }
            },
            @required = new[] { "employeeNo", "name", "email", "roles" }
        }));

    /// <summary>校验工号、邮箱、部门和角色后将新用户持久化。</summary>
    public async Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct)
    {
        // 先拦截空字段和已有工号、邮箱，避免创建不完整或重复的账号。
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var input = ToolJson.Read<Arguments>(arguments);
        if (string.IsNullOrWhiteSpace(input.EmployeeNo) || string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.Email))
            throw new WorkflowException("工号、姓名和邮箱不能为空");
        if (await db.Users.AnyAsync(x => x.EmployeeNo == input.EmployeeNo || x.Email == input.Email, ct))
            throw new WorkflowException("工号或邮箱已存在", 409);
        var departmentItems = await db.Departments.Where(x => x.IsEnabled).ToListAsync(ct);
        var department = string.IsNullOrWhiteSpace(input.Department) ? null : departmentItems.FirstOrDefault(x => x.Id.ToString() == input.Department || x.Code.Equals(input.Department, StringComparison.OrdinalIgnoreCase) || x.Name.Equals(input.Department, StringComparison.OrdinalIgnoreCase))
            ?? throw new WorkflowException("部门不存在或已停用");
        var requestedRoles = input.Roles.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        // 部门和角色支持 ID、编码或名称，但都必须匹配数据库中的真实记录。
        var roleItems = await db.Roles.ToListAsync(ct);
        var roles = roleItems.Where(x => requestedRoles.Any(value => value == x.Id.ToString() || value.Equals(x.Code, StringComparison.OrdinalIgnoreCase) || value.Equals(x.Name, StringComparison.OrdinalIgnoreCase))).ToList();
        if (roles.Count != requestedRoles.Length) throw new WorkflowException("一个或多个角色不存在");
        var user = new AppUser
        {
            EmployeeNo = input.EmployeeNo.Trim(), Name = input.Name.Trim(), Email = input.Email.Trim(),
            DepartmentId = department?.Id, PasswordHash = "", IsEnabled = input.IsEnabled
        };
        // 只存储密码哈希，不在用户表中保存明文初始密码。
        user.PasswordHash = hasher.HashPassword(user, string.IsNullOrWhiteSpace(input.InitialPassword) ? "Bhss@123" : input.InitialPassword);
        user.Roles = roles.Select(x => new UserRole { User = user, Role = x }).ToList();
        await VirtualKeyGrantRules.AssertUserAssignmentAsync(db, user.Id, user.DepartmentId, roles.Select(x => x.Id).ToArray(), ct);
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return new ChatToolResult($"用户 {user.Name}（{user.EmployeeNo}）已创建", new { user.Id, user.EmployeeNo, user.Name });
    }
}

/// <summary>创建部门；可选编码留空时由平台生成唯一编码。</summary>
public sealed class CreateDepartmentTool(AigcHubDbContext db) : IChatTool
{
    private sealed record Arguments(string? Code, string Name, string? Description, Guid? ManagerId, bool IsEnabled = true);
    /// <summary>新建部门工具仅要求部门名称，其余参数使用默认值。</summary>
    public ChatToolDefinition Definition { get; } = new(
        "create_department", "新建部门", "创建组织部门", "department.manage", true,
        ToolJson.Schema(new
        {
            type = "object",
            properties = new { code = new { type = "string", description = "可选；省略时由系统根据部门名称生成" }, name = new { type = "string" }, description = new { type = "string" }, managerId = new { type = "string" }, isEnabled = new { type = "boolean", description = "可选，默认 true" } },
            @required = new[] { "name" }
        }));

    /// <summary>校验部门名称与负责人，生成编码并保存部门。</summary>
    public async Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct)
    {
        // 指定负责人时必须对应已启用用户；编码经统一辅助方法确保唯一。
        var input = ToolJson.Read<Arguments>(arguments);
        if (await db.Departments.AnyAsync(x => x.Name == input.Name, ct))
            throw new WorkflowException("部门名称已存在", 409);
        if (input.ManagerId.HasValue && !await db.Users.AnyAsync(x => x.Id == input.ManagerId && x.IsEnabled, ct))
            throw new WorkflowException("部门负责人不存在或已停用");
        var code = await ToolDefaults.UniqueCodeAsync(input.Code, input.Name, value => db.Departments.AnyAsync(x => x.Code == value, ct));
        var item = new Department { Code = code, Name = input.Name.Trim(), Description = input.Description?.Trim() ?? "", ManagerId = input.ManagerId, IsEnabled = input.IsEnabled };
        db.Departments.Add(item);
        await db.SaveChangesAsync(ct);
        return new ChatToolResult($"部门“{item.Name}”已创建", new { item.Id, item.Code, item.Name });
    }
}

/// <summary>创建应用门户分类，并补齐颜色、排序和启用状态的默认值。</summary>
public sealed class CreateCategoryTool(AigcHubDbContext db) : IChatTool
{
    private sealed record Arguments(string? Code, string Name, string? Description, string? Color, int SortOrder = 0, bool IsEnabled = true);
    /// <summary>新建分类工具仅要求名称，其余参数可由平台确定。</summary>
    public ChatToolDefinition Definition { get; } = new(
        "create_category", "新建分类", "创建应用门户分类", "category.manage", true,
        ToolJson.Schema(new
        {
            type = "object",
            properties = new { code = new { type = "string", description = "可选；省略时由系统根据分类名称生成" }, name = new { type = "string" }, description = new { type = "string" }, color = new { type = "string", description = "可选，默认使用平台蓝色" }, sortOrder = new { type = "integer", description = "可选，默认排在现有分类末尾" }, isEnabled = new { type = "boolean", description = "可选，默认 true" } },
            @required = new[] { "name" }
        }));

    /// <summary>检查分类重名、生成唯一编码并将分类保存到数据库。</summary>
    public async Task<ChatToolResult> ExecuteAsync(Guid userId, JsonElement arguments, CancellationToken ct)
    {
        // 未给颜色使用平台蓝色；未给有效排序时追加到现有分类之后。
        var input = ToolJson.Read<Arguments>(arguments);
        if (await db.Categories.AnyAsync(x => x.Name == input.Name, ct))
            throw new WorkflowException("分类名称已存在", 409);
        var code = await ToolDefaults.UniqueCodeAsync(input.Code, input.Name, value => db.Categories.AnyAsync(x => x.Code == value, ct));
        var item = new AppCategory
        {
            Code = code, Name = input.Name.Trim(), Description = input.Description?.Trim() ?? "",
            Color = string.IsNullOrWhiteSpace(input.Color) ? "#2465d0" : input.Color,
            SortOrder = input.SortOrder > 0 ? input.SortOrder : await db.Categories.CountAsync(ct) + 1,
            IsEnabled = input.IsEnabled
        };
        db.Categories.Add(item);
        await db.SaveChangesAsync(ct);
        return new ChatToolResult($"分类“{item.Name}”已创建", new { item.Id, item.Code, item.Name });
    }
}

/// <summary>为部门和分类生成唯一编码的通用辅助逻辑。</summary>
internal static class ToolDefaults
{
    /// <summary>优先使用显式编码；自动编码冲突时逐步添加数字后缀。</summary>
    public static async Task<string> UniqueCodeAsync(string? requestedCode, string name,
        Func<string, Task<bool>> exists)
    {
        // 手动指定的编码冲突直接报错，不能擅自修改用户明确提供的编码。
        var explicitCode = !string.IsNullOrWhiteSpace(requestedCode);
        var baseCode = explicitCode ? requestedCode!.Trim() : Slug(name);
        if (explicitCode && await exists(baseCode))
            throw new WorkflowException("编码已存在", 409);
        if (!await exists(baseCode)) return baseCode;
        for (var suffix = 2; suffix < 10_000; suffix++)
        {
            var candidate = $"{baseCode}-{suffix}";
            if (!await exists(candidate)) return candidate;
        }
        throw new WorkflowException("无法生成唯一编码，请手动指定编码");
    }

    /// <summary>将名称转换为小写、连字符分隔的基础编码。</summary>
    private static string Slug(string name)
    {
        var chars = name.Trim().ToLowerInvariant().Select(character =>
            character is >= 'a' and <= 'z' or >= '0' and <= '9' ? character : '-').ToArray();
        var value = string.Join('-', new string(chars).Split('-', StringSplitOptions.RemoveEmptyEntries));
        return string.IsNullOrWhiteSpace(value) ? $"item-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}" : value;
    }
}
