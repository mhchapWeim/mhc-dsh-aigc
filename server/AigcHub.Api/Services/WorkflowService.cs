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
    WorkflowDefinitionReader definitions,
    GiteaService? gitea = null,
    ApplicationRouteService? routes = null
)
{
    public async Task<PublicationRequest> SubmitAsync(
        Guid actorId,
        SubmitPublicationRequest input,
        CancellationToken ct
    )
    {
        var resolvedFromGitea = input.CodeSource is not null;
        var repositoryFullName = "";
        if (input.CodeSource is not null)
        {
            if (gitea is null) throw new WorkflowException("Gitea 接入未配置", 409);
            var snapshot = await gitea.ResolveAsync(actorId, input.CodeSource, ct);
            repositoryFullName = snapshot.FullName;
            if (!string.IsNullOrEmpty(input.CommitSha) && input.CommitSha != snapshot.CommitSha)
                throw new WorkflowException("所选版本已有变化，请刷新提交信息后再申请", 409);
            input = input with { RepositoryUrl = snapshot.RepositoryUrl, Branch = snapshot.Branch, CommitSha = snapshot.CommitSha };
        }
        var actor =
            await db.Users.SingleOrDefaultAsync(x => x.Id == actorId && x.IsEnabled, ct)
            ?? throw new WorkflowException("当前用户不可提交申请", 403);
        var categoryExists = await db.Categories.AnyAsync(
            x => x.Id == input.CategoryId && x.IsEnabled && (x.ParentId == null || x.Parent!.IsEnabled),
            ct
        );
        if (!categoryExists)
            throw new WorkflowException("应用分类不存在或已停用");
        if (string.IsNullOrWhiteSpace(input.AppName) || string.IsNullOrWhiteSpace(input.Summary))
            throw new WorkflowException("应用名称和简介不能为空");
        // Only a hand-typed repository address must be HTTPS. When the address comes from
        // the user's verified Gitea repository, the scheme is whatever that server serves
        // (local development runs on plain HTTP), so re-validating it here is wrong.
        if (!resolvedFromGitea && !string.IsNullOrWhiteSpace(input.RepositoryUrl) &&
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
        // The submitted process key is ignored. The server resolves the binding for this entry.
        _ = input.ProcessKey;
        var definition = await ProcessBindings.ResolvePublishedAsync(db, ProcessBindings.Publication, ct);

        var request = new PublicationRequest
        {
            RequestNo =
                $"PUB-{DateTime.UtcNow:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}",
            AppName = input.AppName.Trim(),
            Summary = input.Summary.Trim(),
            AccessUrl = input.AccessUrl?.Trim() ?? "",
            RepositoryUrl = input.RepositoryUrl?.Trim() ?? "",
            RepositoryFullName = repositoryFullName,
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
        if (IntegrationWorkflowRunner.IsIntegrated(definition))
        {
            if (input.CodeSource is null) throw new WorkflowException("第三方发布流程必须选择已授权的 Gitea 仓库");
            request.AccessUrl = "";
            instance.VariablesJson = JsonSerializer.Serialize(new { codeSource = input.CodeSource with { CommitSha = request.CommitSha } }, IntegrationWorkflowRunner.JsonOptions);
            db.AddRange(request, instance);
            await new IntegrationWorkflowRunner(db, definitions).AdvanceAsync(definition, instance, request, null, "succeeded", ct);
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = instance.CurrentNodeKey, ActorId = actorId, EventType = "InstanceStarted", Detail = request.RequestNo });
            await db.SaveChangesAsync(ct);
            return request;
        }
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
        if (request.ApplicantId != actorId || request.Status is not (PublicationStatus.Rejected or PublicationStatus.Failed))
            throw new WorkflowException("当前用户不能重新提交该申请", 403);
        var instance = await db.WorkflowInstances.SingleAsync(
            x => x.Id == request.ProcessInstanceId,
            ct
        );
        var definition = await db.ProcessDefinitions.SingleAsync(
            x => x.Id == instance.ProcessDefinitionId,
            ct
        );
        if (IntegrationWorkflowRunner.IsIntegrated(definition))
        {
            var source = JsonDocument.Parse(instance.VariablesJson).RootElement.GetProperty("codeSource").Deserialize<GiteaSelection>(IntegrationWorkflowRunner.JsonOptions)!;
            if (gitea is null) throw new WorkflowException("Gitea 接入未配置", 409);
            var snapshot = await gitea.ResolveAsync(actorId, source, ct);
            if (!string.Equals(snapshot.CommitSha, request.CommitSha, StringComparison.OrdinalIgnoreCase)) throw new WorkflowException("重新提交的仓库版本与冻结 Commit 不一致", 409);
            request.RepositoryUrl = snapshot.RepositoryUrl;
            request.RepositoryFullName = snapshot.FullName;
            request.AccessUrl = "";
            instance.VariablesJson = JsonSerializer.Serialize(new { codeSource = source }, IntegrationWorkflowRunner.JsonOptions);
            request.ReviewComment = null; request.ReviewerId = null;
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = "start", ActorId = actorId, EventType = "Resubmitted" });
            await new IntegrationWorkflowRunner(db, definitions).AdvanceAsync(definition, instance, request, null, "succeeded", ct);
            await db.SaveChangesAsync(ct);
            return request;
        }
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
        if (instance.BusinessType != ProcessBindings.AccessBusiness && !await HasPermissionAsync(actorId, "publication.review", ct))
            throw new WorkflowException("当前用户没有发布审核权限", 403);
        if (!CanHandle(actor, task))
            throw new WorkflowException("当前用户不是该节点处理人", 403);
        var decision = input.Action.Trim().ToLowerInvariant();
        if (decision is not ("approve" or "reject"))
            throw new WorkflowException("操作必须是 approve 或 reject");
        if (instance.BusinessType == ProcessBindings.AccessBusiness)
            return await CompleteAccessAsync(actor, task, instance, decision, input.Comment, ct);
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
        var currentDefinition = await db.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId, ct);
        if (IntegrationWorkflowRunner.IsIntegrated(currentDefinition))
        {
            await new IntegrationWorkflowRunner(db, definitions).AdvanceAsync(currentDefinition, instance, request, task.NodeKey, decision == "approve" ? "passed" : "rejected", ct);
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = task.NodeKey, ActorId = actorId, EventType = "TaskCompleted", Detail = decision });
            await db.SaveChangesAsync(ct);
            return new { taskId, decision, requestId = request.Id, request.Status };
        }
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
            if (routes is not null) await routes.RegisterAsync(request, deploymentUrl, ct);
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

    public async Task<ApplicationAccessRequest> SubmitAccessAsync(Guid actorId, Guid applicationId, string? reason, CancellationToken ct, bool registered = false)
    {
        var text = reason?.Trim() ?? "";
        if (text.Length is < 1 or > 1000) throw new WorkflowException("请填写 1000 字以内的申请原因");
        var actor = await db.Users.Include(x => x.Roles).Include(x => x.Department).SingleOrDefaultAsync(x => x.Id == actorId && x.IsEnabled, ct)
            ?? throw new WorkflowException("当前用户不可提交申请", 403);
        var gateKey = $"{actorId:N}:{applicationId:N}:{registered}";
        var gate = AccessGates.GetOrAdd(gateKey, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
            if (db.Database.IsNpgsql())
                await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({gateKey}))", ct);
            Guid? publicationId = registered ? null : applicationId;
            Guid? registeredId = registered ? applicationId : null;
            var personal = await db.ApplicationPersonalGrants.AnyAsync(x => x.UserId == actorId &&
                x.PublicationRequestId == publicationId && x.RegisteredApplicationId == registeredId && x.RevokedAt == null, ct);
            string appName;
            bool alreadyAllowed;
            if (registered)
            {
                var app = await db.RegisteredApplications.Include(x => x.Grants).SingleOrDefaultAsync(x => x.Id == applicationId, ct)
                    ?? throw new WorkflowException("目标应用不存在", 404);
                if (!app.IsEnabled)
                    throw new WorkflowException("目标应用已停用，不能提交访问申请", 409);
                appName = app.Name;
                alreadyAllowed = RegisteredApplicationAccess.HasScope(app, actor, personal);
            }
            else
            {
                var app = await db.PublicationRequests.Include(x => x.AccessGrants).SingleOrDefaultAsync(x => x.Id == applicationId, ct)
                    ?? throw new WorkflowException("目标应用不存在", 404);
                if (!app.OperationalEnabled)
                    throw new WorkflowException("目标应用已停用，不能提交访问申请", 409);
                var routeReady = await db.ApplicationRoutes.AnyAsync(x => x.PublicationRequestId == applicationId && x.Status == ApplicationRouteService.Ready, ct);
                if (!routeReady || app.Status != PublicationStatus.Approved)
                    throw new WorkflowException("目标应用未发布或网关路由未就绪，不能提交访问申请", 409);
                appName = app.AppName;
                alreadyAllowed = PublishedApplicationAccess.HasScope(app, actor, personal);
            }
            if (alreadyAllowed)
                throw new WorkflowException("你已经可以访问该应用，无需再次申请", 409);
            if (await db.ApplicationAccessRequests.AnyAsync(x => x.ApplicantId == actorId &&
                x.PublicationRequestId == publicationId && x.RegisteredApplicationId == registeredId && x.Status == AccessRequestStatus.Reviewing, ct))
                throw new WorkflowException("该应用已有一张在途访问申请", 409);
            var definition = await ProcessBindings.ResolvePublishedAsync(db, ProcessBindings.Access, ct);
            var request = new ApplicationAccessRequest
            {
                RequestNo = $"ACC-{DateTime.UtcNow:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}",
                ApplicantId = actorId, PublicationRequestId = publicationId, RegisteredApplicationId = registeredId,
                Reason = text, Status = AccessRequestStatus.Reviewing
            };
            var instance = new WorkflowInstance
            {
                ProcessDefinitionId = definition.Id, BusinessId = request.Id, BusinessType = ProcessBindings.AccessBusiness, InitiatorId = actorId
            };
            request.ProcessInstanceId = instance.Id;
            var task = await definitions.CreateFirstUserTaskAsync(definition, instance.Id, actorId, ct, new AccessAssignment(applicationId, registered));
            instance.CurrentNodeKey = task.NodeKey;
            request.CurrentNodeKey = task.NodeKey;
            request.CurrentNodeName = task.Name;
            db.AddRange(request, instance, task);
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, EventType = "InstanceStarted", NodeKey = task.NodeKey, ActorId = actorId, Detail = request.RequestNo });
            RecordAssignment(instance.Id, task);
            await NotifyCandidatesAsync(task, $"新的访问申请：{appName}", $"{actor.Name} 申请访问 {appName}", "/admin/reviews", ct);
            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
            return request;
        }
        finally { gate.Release(); }
    }

    private async Task<object> CompleteAccessAsync(AppUser actor, WorkflowTask task, WorkflowInstance instance, string decision, string? comment, CancellationToken ct)
    {
        var request = await db.ApplicationAccessRequests.Include(x => x.Publication).Include(x => x.RegisteredApplication)
            .SingleAsync(x => x.Id == instance.BusinessId, ct);
        var appName = request.RegisteredApplication?.Name ?? request.Publication?.AppName ?? "目标应用";
        task.Status = WorkflowTaskStatus.Completed;
        task.CompletedById = actor.Id;
        task.Decision = decision;
        task.Comment = comment?.Trim();
        task.CompletedAt = DateTimeOffset.UtcNow;
        request.ReviewerId = actor.Id;
        request.ReviewComment = task.Comment;
        request.UpdatedAt = DateTimeOffset.UtcNow;
        request.ConcurrencyToken = Guid.NewGuid();
        if (decision == "reject")
        {
            request.Status = AccessRequestStatus.Rejected;
            request.CurrentNodeKey = "revise";
            request.CurrentNodeName = "已驳回";
            instance.Status = WorkflowInstanceStatus.Rejected;
            instance.CurrentNodeKey = "revise";
            instance.CompletedAt = DateTimeOffset.UtcNow;
            await AddNotificationAsync(request.ApplicantId, $"访问申请已驳回：{appName}", task.Comment ?? "未授予访问权限", "/admin/publications", ct);
        }
        else
        {
            var definition = await db.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId, ct);
            var next = await definitions.CreateNextUserTaskAsync(definition, instance.Id, instance.InitiatorId, task.NodeKey, ct, accessApproval: true);
            if (next is not null)
            {
                db.WorkflowTasks.Add(next);
                request.Status = AccessRequestStatus.Reviewing;
                request.CurrentNodeKey = next.NodeKey;
                request.CurrentNodeName = next.Name;
                instance.Status = WorkflowInstanceStatus.Running;
                instance.CurrentNodeKey = next.NodeKey;
                RecordAssignment(instance.Id, next);
                await NotifyCandidatesAsync(next, $"待处理访问申请：{appName}", $"请处理“{next.Name}”", "/admin/reviews", ct);
            }
            else await FinishAccessAsync(request, instance, ct);
        }
        instance.ConcurrencyToken = Guid.NewGuid();
        db.WorkflowHistory.Add(new WorkflowHistory
        {
            InstanceId = instance.Id, EventType = decision == "approve" ? "TaskApproved" : "TaskRejected",
            NodeKey = task.NodeKey, ActorId = actor.Id, Detail = task.Comment ?? ""
        });
        await db.SaveChangesAsync(ct);
        return new { taskId = task.Id, decision, requestId = request.Id, request.Status };
    }

    private async Task FinishAccessAsync(ApplicationAccessRequest request, WorkflowInstance instance, CancellationToken ct)
    {
        var registered = request.RegisteredApplicationId.HasValue;
        var appName = request.RegisteredApplication?.Name ?? request.Publication?.AppName ?? "目标应用";
        var available = registered
            ? request.RegisteredApplication?.IsEnabled == true
            : request.Publication?.Status == PublicationStatus.Approved && request.Publication.OperationalEnabled && await db.ApplicationRoutes.AnyAsync(
                x => x.PublicationRequestId == request.PublicationRequestId && x.Status == ApplicationRouteService.Ready, ct);
        if (!available || !await db.Users.AnyAsync(x => x.Id == request.ApplicantId && x.IsEnabled, ct))
        {
            request.Status = AccessRequestStatus.Failed;
            request.CurrentNodeKey = "failed";
            request.CurrentNodeName = "未授权";
            request.ReviewComment = "目标应用已下架、路由未就绪或申请人已停用，未授予访问权限";
            instance.Status = WorkflowInstanceStatus.Failed;
            instance.CurrentNodeKey = "failed";
            instance.CompletedAt = DateTimeOffset.UtcNow;
            await AddNotificationAsync(request.ApplicantId, $"访问申请未授权：{appName}", request.ReviewComment, "/admin/publications", ct);
            return;
        }
        request.Status = AccessRequestStatus.Approved;
        request.CurrentNodeKey = "approved";
        request.CurrentNodeName = "已授权";
        instance.Status = WorkflowInstanceStatus.Completed;
        instance.CurrentNodeKey = "end";
        instance.CompletedAt = DateTimeOffset.UtcNow;
        var existing = await db.ApplicationPersonalGrants.SingleOrDefaultAsync(x => x.AccessRequestId == request.Id, ct);
        if (existing is null)
        {
            var active = await db.ApplicationPersonalGrants.AnyAsync(x => x.UserId == request.ApplicantId &&
                x.PublicationRequestId == request.PublicationRequestId && x.RegisteredApplicationId == request.RegisteredApplicationId &&
                x.RevokedAt == null, ct);
            if (!active)
                db.ApplicationPersonalGrants.Add(new ApplicationPersonalGrant
                {
                    UserId = request.ApplicantId, PublicationRequestId = request.PublicationRequestId,
                    RegisteredApplicationId = request.RegisteredApplicationId, AccessRequestId = request.Id
                });
        }
        await AddNotificationAsync(request.ApplicantId, $"访问申请已通过：{appName}", "你可以在应用集合中打开该应用", "/", ct);
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> AccessGates = new();

    private void RecordAssignment(Guid instanceId, WorkflowTask task)
    {
        var source = task.Candidates.FirstOrDefault(x => x.Type == "source")?.Value;
        if (source is null) return;
        db.WorkflowHistory.Add(new WorkflowHistory
        {
            InstanceId = instanceId, EventType = "TaskAssigned", NodeKey = task.NodeKey,
            Detail = source == "owner" ? "分配给应用负责人" : "转交兜底审核角色"
        });
    }

    private Task<bool> HasPermissionAsync(Guid userId, string permission, CancellationToken ct) =>
        db.Users.AsNoTracking().Where(x => x.Id == userId)
            .SelectMany(x => x.Roles).SelectMany(x => x.Role.Permissions)
            .AnyAsync(x => x.Permission.Code == permission, ct);

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
