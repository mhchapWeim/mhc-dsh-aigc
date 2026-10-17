using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

/// <summary>
/// 智能对话相关的 HTTP 端点：管理会话与消息，并将企业工具的提议、确认和取消交由服务层处理。
/// </summary>
public static class ChatEndpoints
{
    /// <summary>
    /// 注册聊天接口。整个路由组要求当前用户具备门户访问权限。
    /// </summary>
    public static void MapChatEndpoints(this IEndpointRouteBuilder app)
    {
        // 先为所有聊天接口设置统一前缀、标签和基础鉴权，再按资源类型注册端点。
        var chat = app.MapGroup("/api/chat").WithTags("智能对话").RequireAuthorization("portal.view");
        // 工具列表按当前用户的权限过滤；模型列表只返回可用于对话的模型。
        chat.MapGet("/tools", async (ICurrentUser current, ChatToolRegistry tools, CancellationToken ct) =>
            Results.Ok(await tools.AvailableAsync(current.Id, ct)));
        chat.MapGet("/models", async (ICurrentUser current, ModelConfigurationService models, CancellationToken ct) =>
            Results.Ok(await models.AvailableAsync(current.Id, ct)));
        // 会话管理、消息收发及需要用户确认的工具执行分别由对应处理方法负责。
        chat.MapGet("/tool-options", ToolOptionsAsync);
        chat.MapGet("/conversations", ListConversationsAsync);
        chat.MapPost("/conversations", CreateConversationAsync);
        chat.MapPut("/conversations/{id:guid}/title", RenameConversationAsync);
        chat.MapPost("/conversations/{id:guid}/archive", ArchiveConversationAsync);
        chat.MapPost("/conversations/{id:guid}/restore", RestoreConversationAsync);
        chat.MapDelete("/conversations/{id:guid}", DeleteConversationAsync);
        chat.MapGet("/conversations/{id:guid}/messages", ListMessagesAsync);
        chat.MapGet("/conversations/{id:guid}/pending-tool-executions", ListPendingToolExecutionsAsync);
        chat.MapPost("/messages", SendMessageAsync);
        chat.MapPost("/tool-executions", ProposeToolAsync);
        chat.MapPost("/tool-executions/{id:guid}/confirm", ConfirmToolAsync);
        chat.MapPost("/tool-executions/{id:guid}/cancel", CancelToolAsync);
    }

    /// <summary>
    /// 返回企业工具表单可选的数据；不同选项依据当前用户的权限单独过滤。
    /// </summary>
    private static async Task<IResult> ToolOptionsAsync(ICurrentUser current, DatabasePermissionService permissions,
        AigcHubDbContext db, CancellationToken ct)
    {
        // 使用数据库中的实时权限，避免仅靠前端隐藏选项来控制访问。
        var granted = await permissions.GetPermissionsAsync(current.Id, ct);
        // 发布申请可选择分类；用户管理可选择部门和角色；部门或发布相关权限可选择人员。
        var categories = granted.Contains("publication.create")
            ? await db.Categories.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.SortOrder)
                .Select(x => new { x.Id, x.Code, x.Name }).ToListAsync(ct)
            : [];
        var departments = granted.Contains("user.manage")
            ? await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
                .Select(x => new { x.Id, x.Code, x.Name }).ToListAsync(ct)
            : [];
        var roles = granted.Contains("user.manage")
            ? await db.Roles.AsNoTracking().OrderBy(x => x.Name)
                .Select(x => new { x.Id, x.Code, x.Name }).ToListAsync(ct)
            : [];
        var users = granted.Contains("department.manage") || granted.Contains("publication.create")
            ? await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
                .Select(x => new { x.Id, x.EmployeeNo, x.Name, Department = x.Department == null ? "未分配部门" : x.Department.Name }).ToListAsync(ct)
            : [];
        return Results.Ok(new { categories, departments, roles, users });
    }

    /// <summary>
    /// 按归档状态查询当前用户的会话，并按最近更新时间倒序返回。
    /// </summary>
    private static async Task<IResult> ListConversationsAsync(bool? archived, ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        // 缺省查询未归档会话，且只读取当前用户拥有的会话。
        var archiveState = archived ?? false;
        var items = await db.ChatConversations.AsNoTracking().Where(x => x.UserId == current.Id && x.IsArchived == archiveState)
            .OrderByDescending(x => x.UpdatedAt).Take(100)
            .Select(x => new { x.Id, x.Title, ModelId = x.ModelConfigurationId, x.IsArchived, x.CreatedAt, x.UpdatedAt }).ToListAsync(ct);
        return Results.Ok(items);
    }

    /// <summary>
    /// 为当前用户创建会话；未填写标题时使用默认名称“新对话”。
    /// </summary>
    private static async Task<IResult> CreateConversationAsync(CreateChatConversationRequest input,
        ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var item = new ChatConversation { UserId = current.Id, ModelConfigurationId = input.ModelId, Title = string.IsNullOrWhiteSpace(input.Title) ? "新对话" : input.Title.Trim() };
        db.ChatConversations.Add(item);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { item.Id, item.Title, ModelId = item.ModelConfigurationId, item.IsArchived, item.CreatedAt, item.UpdatedAt });
    }

    /// <summary>
    /// 修改当前用户所拥有会话的标题，并限制标题长度。
    /// </summary>
    private static async Task<IResult> RenameConversationAsync(Guid id, RenameChatConversationRequest input,
        ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        // 先校验新标题，再验证会话归属，防止修改其他用户的会话。
        if (string.IsNullOrWhiteSpace(input.Title)) return Results.BadRequest(new { message = "对话名称不能为空" });
        var item = await OwnedConversationAsync(id, current.Id, db, ct);
        if (item is null) return Results.NotFound();
        item.Title = input.Title.Trim()[..Math.Min(input.Title.Trim().Length, 80)];
        item.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { item.Id, item.Title, ModelId = item.ModelConfigurationId, item.IsArchived, item.CreatedAt, item.UpdatedAt });
    }

    /// <summary>将当前用户的会话标记为已归档。</summary>
    private static Task<IResult> ArchiveConversationAsync(Guid id, ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        SetArchiveStateAsync(id, true, current.Id, db, ct);

    /// <summary>恢复当前用户已归档的会话。</summary>
    private static Task<IResult> RestoreConversationAsync(Guid id, ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        SetArchiveStateAsync(id, false, current.Id, db, ct);

    /// <summary>
    /// 归档与恢复共用的状态更新逻辑，同时刷新会话更新时间。
    /// </summary>
    private static async Task<IResult> SetArchiveStateAsync(Guid id, bool archived, Guid userId,
        AigcHubDbContext db, CancellationToken ct)
    {
        // 只有会话所有者可以切换归档状态。
        var item = await OwnedConversationAsync(id, userId, db, ct);
        if (item is null) return Results.NotFound();
        item.IsArchived = archived;
        item.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { item.Id, item.Title, ModelId = item.ModelConfigurationId, item.IsArchived, item.CreatedAt, item.UpdatedAt });
    }

    /// <summary>
    /// 删除当前用户的会话及其工具执行记录。
    /// </summary>
    private static async Task<IResult> DeleteConversationAsync(Guid id, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        // 先验证归属，再清理与会话关联的工具执行；消息随会话的数据库关系一并处理。
        var item = await OwnedConversationAsync(id, current.Id, db, ct);
        if (item is null) return Results.NotFound();
        await db.ChatToolExecutions.Where(x => x.ConversationId == id).ExecuteDeleteAsync(ct);
        db.ChatConversations.Remove(item);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>按会话 ID 和用户 ID 查询会话，供需要校验归属的操作复用。</summary>
    private static Task<ChatConversation?> OwnedConversationAsync(Guid id, Guid userId,
        AigcHubDbContext db, CancellationToken ct) =>
        db.ChatConversations.SingleOrDefaultAsync(x => x.Id == id && x.UserId == userId, ct);

    /// <summary>按时间顺序返回当前用户指定会话中的消息。</summary>
    private static async Task<IResult> ListMessagesAsync(Guid id, ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        // 即使消息表中存在该会话记录，也必须先确认会话属于当前用户。
        if (!await db.ChatConversations.AnyAsync(x => x.Id == id && x.UserId == current.Id, ct)) return Results.NotFound();
        var items = await db.ChatMessages.AsNoTracking().Where(x => x.ConversationId == id)
            .OrderBy(x => x.CreatedAt).Select(x => new { x.Id, x.Role, x.Content, x.ToolExecutionId, x.CreatedAt }).ToListAsync(ct);
        return Results.Ok(items);
    }

    /// <summary>
    /// 查询当前会话仍等待确认的工具执行，供页面刷新后恢复确认操作区。
    /// </summary>
    private static async Task<IResult> ListPendingToolExecutionsAsync(Guid id, ICurrentUser current,
        ChatToolExecutionService executions, CancellationToken ct) =>
        Results.Ok(await executions.ListPendingAsync(current.Id, id, ct));

    /// <summary>
    /// 接收用户消息，交由对话编排服务调用模型并处理可能产生的工具提议。
    /// </summary>
    private static async Task<IResult> SendMessageAsync(ChatMessageRequest input, ICurrentUser current,
        ChatOrchestrator orchestrator, CancellationToken ct) =>
        Results.Ok(await orchestrator.SendAsync(current.Id, input.ConversationId, input.Content, input.ModelId, ct));

    /// <summary>
    /// 根据工具名称和参数创建执行提议；需确认的写操作不会在此步直接执行。
    /// </summary>
    private static async Task<IResult> ProposeToolAsync(ExecuteChatToolRequest input, Guid conversationId,
        ICurrentUser current, ChatToolExecutionService executions, CancellationToken ct) =>
        Results.Ok(await executions.ProposeAsync(current.Id, conversationId, input.ToolName, input.Arguments, ct));

    /// <summary>
    /// 确认执行指定工具，由服务层再次验证执行归属、状态和操作权限。
    /// </summary>
    private static async Task<IResult> ConfirmToolAsync(Guid id, ICurrentUser current,
        ChatToolExecutionService executions, CancellationToken ct) =>
        Results.Ok(await executions.ConfirmAsync(current.Id, id, ct));

    /// <summary>取消指定的待确认工具执行。</summary>
    private static async Task<IResult> CancelToolAsync(Guid id, ICurrentUser current,
        ChatToolExecutionService executions, CancellationToken ct) =>
        Results.Ok(await executions.CancelAsync(current.Id, id, ct));
}
