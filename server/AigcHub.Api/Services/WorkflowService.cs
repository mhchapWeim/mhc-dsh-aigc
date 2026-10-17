using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed class NotificationHub : Hub
{
    public override async Task OnConnectedAsync()
    {
        var userId = Context.UserIdentifier;
        if (!string.IsNullOrWhiteSpace(userId))
            await Groups.AddToGroupAsync(Context.ConnectionId, $"user:{userId}");
        await base.OnConnectedAsync();
    }
}

public interface IRealtimeNotificationPublisher
{
    Task PublishAsync(Guid userId, string title, string content, string link, CancellationToken ct);
}

public sealed class SignalRNotificationPublisher(IHubContext<NotificationHub> hub)
    : IRealtimeNotificationPublisher
{
    public Task PublishAsync(
        Guid userId,
        string title,
        string content,
        string link,
        CancellationToken ct
    ) =>
        hub
            .Clients.Group($"user:{userId}")
            .SendAsync(
                "notification",
                new
                {
                    title,
                    content,
                    link,
                },
                ct
            );
}

public sealed class WorkflowException(string message, int statusCode = 400) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

public sealed class WorkflowService(
    AigcHubDbContext db,
    IRealtimeNotificationPublisher realtime,
    WorkflowDefinitionReader definitions
)
{
    public async Task<PublicationRequest> SubmitAsync(
        Guid actorId,
        SubmitPublicationRequest input,
        CancellationToken ct
    )
    {
        var actor =
            await db.Users.SingleOrDefaultAsync(x => x.Id == actorId && x.IsEnabled, ct)
            ?? throw new WorkflowException("当前用户不可提交申请", 403);
        var categoryExists = await db.Categories.AnyAsync(
            x => x.Id == input.CategoryId && x.IsEnabled,
            ct
        );
        if (!categoryExists)
            throw new WorkflowException("应用分类不存在或已停用");
        if (string.IsNullOrWhiteSpace(input.AppName) || string.IsNullOrWhiteSpace(input.Summary))
            throw new WorkflowException("应用名称和简介不能为空");
        if (!string.IsNullOrWhiteSpace(input.RepositoryUrl) &&
            (!Uri.TryCreate(input.RepositoryUrl, UriKind.Absolute, out var repositoryUri) || repositoryUri.Scheme != Uri.UriSchemeHttps))
            throw new WorkflowException("代码仓库必须是有效的 HTTPS 地址");
        if (!string.IsNullOrWhiteSpace(input.CommitSha) && input.CommitSha.Trim().Length < 7)
            throw new WorkflowException("Commit SHA 至少需要 7 位");
        var accessMode = string.IsNullOrWhiteSpace(input.AccessMode) ? "All" : input.AccessMode.Trim();
        if (accessMode is not ("All" or "Subjects"))
            throw new WorkflowException("可访问范围必须是 All 或 Subjects");
        var accessSubjects = input.AccessSubjects ?? [];
        if (accessMode == "Subjects" && accessSubjects.Length == 0)
            throw new WorkflowException("请选择至少一个可访问人员、部门或角色");
        await ValidateAccessSubjectsAsync(accessSubjects, ct);
        var definition =
            await db
                .ProcessDefinitions.OrderByDescending(x => x.Version)
                .FirstOrDefaultAsync(x => x.Key == "application-publishing" && x.IsPublished, ct)
            ?? throw new WorkflowException("没有已发布的应用发布流程", 409);

        var request = new PublicationRequest
        {
            RequestNo =
                $"PUB-{DateTime.UtcNow:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}",
            AppName = input.AppName.Trim(),
            Summary = input.Summary.Trim(),
            AccessUrl = input.AccessUrl?.Trim() ?? "",
            RepositoryUrl = input.RepositoryUrl?.Trim() ?? "",
            Branch = input.Branch?.Trim() ?? "",
            CommitSha = input.CommitSha?.Trim() ?? "",
            Version = input.Version?.Trim() ?? "",
            Environment = input.Environment?.Trim() ?? "Production",
            AccessMode = accessMode,
            CategoryId = input.CategoryId,
            ApplicantId = actorId,
            Status = PublicationStatus.Reviewing,
        };
        foreach (var subject in accessSubjects.DistinctBy(x => new { x.SubjectType, x.SubjectId }))
            request.AccessGrants.Add(new PublicationAccessGrant
            {
                SubjectType = NormalizeSubjectType(subject.SubjectType), SubjectId = subject.SubjectId
            });
        var instance = new WorkflowInstance
        {
            ProcessDefinitionId = definition.Id,
            BusinessId = request.Id,
            BusinessType = "application-publication",
            InitiatorId = actorId,
        };
        request.ProcessInstanceId = instance.Id;
        var task = await definitions.CreateFirstUserTaskAsync(definition, instance.Id, actorId, ct);
        instance.CurrentNodeKey = task.NodeKey;
        request.CurrentNodeKey = task.NodeKey;
        request.CurrentNodeName = task.Name;
        db.AddRange(request, instance, task);
        db.WorkflowHistory.Add(
            new WorkflowHistory
            {
                InstanceId = instance.Id,
                EventType = "InstanceStarted",
                NodeKey = task.NodeKey,
                ActorId = actorId,
                Detail = request.RequestNo,
            }
        );
        await NotifyCandidatesAsync(
            task,
            $"新的应用发布申请：{request.AppName}",
            "请处理应用发布审核任务",
            "/admin/reviews",
            ct
        );
        await db.SaveChangesAsync(ct);
        return request;
    }

    public async Task<PublicationRequest> ResubmitAsync(
        Guid actorId,
        Guid requestId,
        CancellationToken ct
    )
    {
        var request =
            await db.PublicationRequests.SingleOrDefaultAsync(x => x.Id == requestId, ct)
            ?? throw new WorkflowException("申请不存在", 404);
        if (request.ApplicantId != actorId || request.Status != PublicationStatus.Rejected)
            throw new WorkflowException("当前用户不能重新提交该申请", 403);
        var instance = await db.WorkflowInstances.SingleAsync(
            x => x.Id == request.ProcessInstanceId,
            ct
        );
        var definition = await db.ProcessDefinitions.SingleAsync(
            x => x.Id == instance.ProcessDefinitionId,
            ct
        );
        var task = await definitions.CreateFirstUserTaskAsync(definition, instance.Id, actorId, ct);
        instance.Status = WorkflowInstanceStatus.Running;
        instance.CurrentNodeKey = task.NodeKey;
        instance.ConcurrencyToken = Guid.NewGuid();
        request.Status = PublicationStatus.Reviewing;
        request.CurrentNodeKey = task.NodeKey;
        request.CurrentNodeName = task.Name;
        request.ReviewComment = null;
        request.ReviewerId = null;
        request.UpdatedAt = DateTimeOffset.UtcNow;
        request.ConcurrencyToken = Guid.NewGuid();
        db.WorkflowTasks.Add(task);
        db.WorkflowHistory.Add(
            new WorkflowHistory
            {
                InstanceId = instance.Id,
                EventType = "Resubmitted",
                NodeKey = "review",
                ActorId = actorId,
            }
        );
        await NotifyCandidatesAsync(
            task,
            $"应用发布申请已重新提交：{request.AppName}",
            "请重新处理审核任务",
            "/admin/reviews",
            ct
        );
        await db.SaveChangesAsync(ct);
        return request;
    }

    public async Task<object> CompleteTaskAsync(
        Guid actorId,
        Guid taskId,
        CompleteTaskRequest input,
        CancellationToken ct
    )
    {
        var task =
            await db
                .WorkflowTasks.Include(x => x.Candidates)
                .SingleOrDefaultAsync(x => x.Id == taskId, ct)
            ?? throw new WorkflowException("任务不存在", 404);
        if (task.Status != WorkflowTaskStatus.Pending)
            throw new WorkflowException("任务已经处理", 409);
        var actor =
            await db
                .Users.Include(x => x.Department)
                .Include(x => x.Roles)
                    .ThenInclude(x => x.Role)
                .SingleOrDefaultAsync(x => x.Id == actorId && x.IsEnabled, ct)
            ?? throw new WorkflowException("当前用户不存在或已停用", 403);
        var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == task.InstanceId, ct);
        if (instance.InitiatorId == actorId)
            throw new WorkflowException("申请人不能审核自己提交的申请", 403);
        if (!CanHandle(actor, task))
            throw new WorkflowException("当前用户不是该节点处理人", 403);
        var decision = input.Action.Trim().ToLowerInvariant();
        if (decision is not ("approve" or "reject"))
            throw new WorkflowException("操作必须是 approve 或 reject");
        var request = await db.PublicationRequests.SingleAsync(
            x => x.Id == instance.BusinessId,
            ct
        );

        task.Status = WorkflowTaskStatus.Completed;
        task.CompletedById = actorId;
        task.Decision = decision;
        task.Comment = input.Comment?.Trim();
        task.CompletedAt = DateTimeOffset.UtcNow;
        request.ReviewerId = actorId;
        request.ReviewComment = task.Comment;
        request.UpdatedAt = DateTimeOffset.UtcNow;
        request.ConcurrencyToken = Guid.NewGuid();
        string? correlationId = null;
        if (decision == "reject")
        {
            request.Status = PublicationStatus.Rejected;
            request.CurrentNodeKey = "revise";
            request.CurrentNodeName = "修改申请";
            instance.Status = WorkflowInstanceStatus.Rejected;
            instance.CurrentNodeKey = "revise";
            await AddNotificationAsync(
                request.ApplicantId,
                $"应用发布申请已退回：{request.AppName}",
                task.Comment ?? "请修改后重新提交",
                "/admin/publications",
                ct
            );
        }
        else
        {
            var definition = await db.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId, ct);
            var nextTask = await definitions.CreateNextUserTaskAsync(definition, instance.Id, instance.InitiatorId, task.NodeKey, ct);
            if (nextTask is not null)
            {
                db.WorkflowTasks.Add(nextTask);
                request.Status = PublicationStatus.Reviewing;
                request.CurrentNodeKey = nextTask.NodeKey;
                request.CurrentNodeName = nextTask.Name;
                instance.Status = WorkflowInstanceStatus.Running;
                instance.CurrentNodeKey = nextTask.NodeKey;
                await NotifyCandidatesAsync(nextTask, $"待处理发布流程：{request.AppName}",
                    $"“{task.Name}”已通过，请处理“{nextTask.Name}”", "/admin/reviews", ct);
            }
            else
            {
                correlationId = Guid.NewGuid().ToString("N");
                request.Status = PublicationStatus.Publishing;
                request.CurrentNodeKey = "publish";
                request.CurrentNodeName = "等待部署服务回调";
                instance.Status = WorkflowInstanceStatus.WaitingCallback;
                instance.CurrentNodeKey = "publish";
                db.CallbackSubscriptions.Add(new WorkflowCallbackSubscription
                {
                    InstanceId = instance.Id, EventType = "application-publish", CorrelationId = correlationId,
                    ExpiresAt = DateTimeOffset.UtcNow.AddHours(24)
                });
                await AddNotificationAsync(request.ApplicantId, $"应用部署审批已通过：{request.AppName}",
                    "正在等待部署服务返回访问地址", "/admin/publications", ct);
            }
        }
        instance.ConcurrencyToken = Guid.NewGuid();
        db.WorkflowHistory.Add(
            new WorkflowHistory
            {
                InstanceId = instance.Id,
                EventType = decision == "approve" ? "TaskApproved" : "TaskRejected",
                NodeKey = task.NodeKey,
                ActorId = actorId,
                Detail = task.Comment ?? "",
            }
        );
        await db.SaveChangesAsync(ct);
        return new
        {
            taskId,
            decision,
            requestId = request.Id,
            request.Status,
            correlationId,
        };
    }

    public async Task<CallbackResult> ReceiveCallbackAsync(
        CallbackRequest input,
        CancellationToken ct
    )
    {
        if (await db.CallbackInbox.AnyAsync(x => x.EventId == input.EventId, ct))
            return new CallbackResult(true, true, "事件已处理");
        var subscription = await db.CallbackSubscriptions.SingleOrDefaultAsync(
            x => x.CorrelationId == input.CorrelationId,
            ct
        );
        if (subscription is null)
            throw new WorkflowException("找不到对应的回调订阅", 404);
        if (subscription.IsConsumed)
            return new CallbackResult(true, true, "订阅已消费");
        if (subscription.ExpiresAt < DateTimeOffset.UtcNow)
            throw new WorkflowException("回调订阅已过期", 410);
        var instance = await db.WorkflowInstances.SingleAsync(
            x => x.Id == subscription.InstanceId,
            ct
        );
        var request = await db.PublicationRequests.SingleAsync(
            x => x.Id == instance.BusinessId,
            ct
        );
        db.CallbackInbox.Add(
            new WorkflowCallbackInbox
            {
                EventId = input.EventId,
                CorrelationId = input.CorrelationId,
                PayloadJson = JsonSerializer.Serialize(input),
            }
        );
        subscription.IsConsumed = true;
        subscription.ConsumedAt = DateTimeOffset.UtcNow;
        var succeeded = input.Status.Equals("Succeeded", StringComparison.OrdinalIgnoreCase);
        string? deploymentUrl = null;
        if (succeeded)
        {
            if (!input.Data.TryGetProperty("deploymentUrl", out var urlProperty))
                throw new WorkflowException("成功回调必须包含 deploymentUrl");
            deploymentUrl = urlProperty.GetString()?.Trim();
            if (!Uri.TryCreate(deploymentUrl, UriKind.Absolute, out var parsed) || parsed.Scheme != Uri.UriSchemeHttps)
                throw new WorkflowException("deploymentUrl 必须是有效的 HTTPS 地址");
            if (input.Data.TryGetProperty("commitSha", out var commitProperty) &&
                !string.IsNullOrWhiteSpace(request.CommitSha) &&
                !string.Equals(request.CommitSha, commitProperty.GetString(), StringComparison.OrdinalIgnoreCase))
                throw new WorkflowException("部署回调的 Commit 与代码审核版本不一致", 409);
            request.AccessUrl = deploymentUrl;
        }
        instance.Status = succeeded
            ? WorkflowInstanceStatus.Completed
            : WorkflowInstanceStatus.Failed;
        instance.CurrentNodeKey = succeeded ? "end" : "publish-failed";
        instance.CompletedAt = DateTimeOffset.UtcNow;
        instance.ConcurrencyToken = Guid.NewGuid();
        request.Status = succeeded ? PublicationStatus.Approved : PublicationStatus.Failed;
        request.CurrentNodeKey = succeeded ? "published" : "publish-failed";
        request.CurrentNodeName = succeeded ? "发布完成" : "发布失败";
        request.UpdatedAt = DateTimeOffset.UtcNow;
        request.ConcurrencyToken = Guid.NewGuid();
        db.WorkflowHistory.Add(
            new WorkflowHistory
            {
                InstanceId = instance.Id,
                EventType = succeeded ? "CallbackSucceeded" : "CallbackFailed",
                NodeKey = "publish",
                Detail = input.EventId,
            }
        );
        await AddNotificationAsync(
            request.ApplicantId,
            succeeded ? $"应用已发布：{request.AppName}" : $"应用发布失败：{request.AppName}",
            succeeded ? "应用发布流程已完成" : "请联系平台管理员处理",
            "/admin/publications",
            ct
        );
        await db.SaveChangesAsync(ct);
        return new CallbackResult(true, false);
    }

    private async Task ValidateAccessSubjectsAsync(AccessSubjectRequest[] subjects, CancellationToken ct)
    {
        foreach (var subject in subjects)
        {
            var type = NormalizeSubjectType(subject.SubjectType);
            var exists = type switch
            {
                "User" => await db.Users.AnyAsync(x => x.Id == subject.SubjectId && x.IsEnabled, ct),
                "Department" => await db.Departments.AnyAsync(x => x.Id == subject.SubjectId && x.IsEnabled, ct),
                "Role" => await db.Roles.AnyAsync(x => x.Id == subject.SubjectId, ct),
                _ => false
            };
            if (!exists) throw new WorkflowException($"可访问对象不存在：{type}/{subject.SubjectId}");
        }
    }

    private static string NormalizeSubjectType(string value) => value.Trim().ToLowerInvariant() switch
    {
        "user" => "User", "department" => "Department", "role" => "Role",
        _ => throw new WorkflowException("可访问对象类型必须是 User、Department 或 Role")
    };

    public async Task<bool> CanHandleAsync(Guid actorId, WorkflowTask task, CancellationToken ct)
    {
        var initiatorId = await db
            .WorkflowInstances.Where(x => x.Id == task.InstanceId)
            .Select(x => x.InitiatorId)
            .SingleAsync(ct);
        if (initiatorId == actorId)
            return false;
        var actor = await db
            .Users.Include(x => x.Department)
            .Include(x => x.Roles)
                .ThenInclude(x => x.Role)
            .SingleOrDefaultAsync(x => x.Id == actorId && x.IsEnabled, ct);
        return actor is not null && CanHandle(actor, task);
    }

    private static bool CanHandle(AppUser actor, WorkflowTask task)
    {
        if (task.AssigneeId == actor.Id)
            return true;
        return task.Candidates.Any(x => x.Type == "user" && x.Value == actor.Id.ToString())
            || task.Candidates.Any(x => x.Type == "department" && x.Value == actor.Department?.Code)
            || task.Candidates.Any(x =>
                x.Type == "role" && actor.Roles.Any(r => r.Role.Code == x.Value)
            );
    }

    private async Task NotifyCandidatesAsync(
        WorkflowTask task,
        string title,
        string content,
        string link,
        CancellationToken ct
    )
    {
        var users = await db
            .Users.Include(x => x.Department)
            .Include(x => x.Roles)
                .ThenInclude(x => x.Role)
            .Where(x => x.IsEnabled)
            .ToListAsync(ct);
        foreach (var user in users.Where(x => CanHandle(x, task)))
            await AddNotificationAsync(user.Id, title, content, link, ct);
    }

    private async Task AddNotificationAsync(
        Guid userId,
        string title,
        string content,
        string link,
        CancellationToken ct
    )
    {
        db.Notifications.Add(
            new InboxNotification
            {
                UserId = userId,
                Title = title,
                Content = content,
                Link = link,
            }
        );
        await realtime.PublishAsync(userId, title, content, link, ct);
    }
}
