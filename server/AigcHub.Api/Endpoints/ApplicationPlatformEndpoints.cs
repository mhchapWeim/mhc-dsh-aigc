using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class ApplicationPlatformEndpoints
{
    public sealed record BindInput(string ProcessKey);
    public sealed record AccessSubmitInput(Guid ApplicationId, string Reason);
    public sealed record RegisteredAccessSubmitInput(string Reason);
    public sealed record GatewaySettingInput(int IdleTimeoutMinutes, int MaxSessionHours, int LaunchTicketSeconds);
    public sealed record RevokeInput(string? Reason);

    public static void MapApplicationPlatformEndpoints(this IEndpointRouteBuilder app)
    {
        var bindings = app.MapGroup("/api/process-bindings").RequireAuthorization("process.design").WithTags("流程绑定");
        bindings.MapGet("/", ListBindingsAsync);
        bindings.MapPut("/{requestType}", SaveBindingAsync);

        var access = app.MapGroup("/api/access-requests").RequireAuthorization().WithTags("访问申请");
        access.MapGet("/eligible-apps", EligibleAppsAsync).RequireAuthorization("publication.create");
        access.MapGet("/mine", MyAccessAsync).RequireAuthorization("publication.create");
        access.MapGet("/reviewable", ReviewableAccessAsync);
        access.MapGet("/{id:guid}", AccessDetailAsync);
        access.MapPost("/", (AccessSubmitInput input, ICurrentUser current, WorkflowService workflow, CancellationToken ct) =>
            SubmitAccessAsync(input.ApplicationId, input.Reason, current, workflow, ct, registered: false))
            .RequireAuthorization("publication.create");
        app.MapPost("/api/catalog/registered-apps/{id:guid}/access-request",
            (Guid id, RegisteredAccessSubmitInput input, ICurrentUser current, WorkflowService workflow, CancellationToken ct) =>
                SubmitAccessAsync(id, input.Reason, current, workflow, ct, registered: true))
            .RequireAuthorization("portal.view").WithTags("访问申请");

        var gateway = app.MapGroup("/api/gateway-settings").RequireAuthorization("gateway.manage").WithTags("应用网关");
        gateway.MapGet("/", async (GatewaySettingsService settings, AigcHubDbContext db, CancellationToken ct) =>
        {
            var current = await settings.CurrentAsync(ct);
            var changes = await db.ApplicationGatewaySettingChanges.AsNoTracking().OrderByDescending(x => x.CreatedAt).Take(10).ToListAsync(ct);
            var actorIds = changes.Select(x => x.ActorId).Distinct().ToList();
            var actors = await db.Users.AsNoTracking().Where(x => actorIds.Contains(x.Id)).Select(x => new { x.Id, x.Name, x.EmployeeNo }).ToListAsync(ct);
            return Results.Ok(new
            {
                current.IdleTimeoutMinutes,
                current.MaxSessionHours,
                current.LaunchTicketSeconds,
                changes = changes.Select(x =>
                {
                    var actor = actors.FirstOrDefault(user => user.Id == x.ActorId);
                    return new { x.Id, x.ActorId, ActorName = actor?.Name ?? "", EmployeeNo = actor?.EmployeeNo ?? "", x.CreatedAt, x.BeforeJson, x.AfterJson };
                })
            });
        });
        gateway.MapPut("/", async (GatewaySettingInput input, ICurrentUser current, GatewaySettingsService settings, CancellationToken ct) =>
            Results.Ok(await settings.SaveAsync(current.Id, input.IdleTimeoutMinutes, input.MaxSessionHours, input.LaunchTicketSeconds, ct)));
        gateway.MapGet("/routes", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.ApplicationRoutes.AsNoTracking().OrderBy(x => x.Slug)
                .Select(x => new { x.Id, x.PublicationRequestId, x.Slug, x.UpstreamUrl, x.Status, x.Detail, x.UpdatedAt }).ToListAsync(ct)));
        gateway.MapGet("/grants", async (AigcHubDbContext db, CancellationToken ct) =>
        {
            var grants = await db.ApplicationPersonalGrants.AsNoTracking().OrderByDescending(x => x.GrantedAt).Take(200).ToListAsync(ct);
            var userIds = grants.Select(x => x.UserId).Distinct().ToList();
            var appIds = grants.Select(x => x.PublicationRequestId).Distinct().ToList();
            var registeredIds = grants.Select(x => x.RegisteredApplicationId).Distinct().ToList();
            var users = await db.Users.AsNoTracking().Where(x => userIds.Contains(x.Id)).Select(x => new { x.Id, x.Name, x.EmployeeNo }).ToListAsync(ct);
            var apps = await db.PublicationRequests.AsNoTracking().Where(x => appIds.Contains(x.Id)).Select(x => new { x.Id, x.AppName }).ToListAsync(ct);
            var registered = await db.RegisteredApplications.AsNoTracking().Where(x => registeredIds.Contains(x.Id)).Select(x => new { x.Id, x.Name }).ToListAsync(ct);
            return Results.Ok(grants.Select(x =>
            {
                var user = users.FirstOrDefault(item => item.Id == x.UserId);
                var app = apps.FirstOrDefault(item => item.Id == x.PublicationRequestId);
                return new
                {
                    x.Id, x.UserId, UserName = user?.Name ?? "", EmployeeNo = user?.EmployeeNo ?? "",
                    x.PublicationRequestId, x.RegisteredApplicationId,
                    AppName = app?.AppName ?? registered.FirstOrDefault(item => item.Id == x.RegisteredApplicationId)?.Name ?? "",
                    x.Source, x.GrantedAt, x.RevokedAt, x.RevokeReason
                };
            }));
        });
        gateway.MapPost("/grants/{id:guid}/revoke", RevokeAsync);

        app.MapPost("/api/catalog/apps/{id:guid}/launch", LaunchAsync).RequireAuthorization("portal.view").WithTags("应用目录");
    }

    private static async Task<IResult> ListBindingsAsync(AigcHubDbContext db, CancellationToken ct)
    {
        var bindings = await db.RequestProcessBindings.AsNoTracking().ToListAsync(ct);
        var definitions = await db.ProcessDefinitions.AsNoTracking().ToListAsync(ct);
        return Results.Ok(new[] { ProcessBindings.Publication, ProcessBindings.Access }.Select(type =>
        {
            var binding = bindings.SingleOrDefault(x => x.RequestType == type);
            var published = binding is null ? null : definitions.Where(x => x.Key == binding.ProcessKey && x.IsPublished && x.RequestType == type)
                .OrderByDescending(x => x.Version).FirstOrDefault();
            var options = definitions.Where(x => x.RequestType == type && x.IsPublished)
                .GroupBy(x => x.Key).Select(group => group.OrderByDescending(x => x.Version).First())
                .OrderBy(x => x.Name).Select(x => new { x.Key, x.Name, x.Version, Label = $"{x.Name}（{x.Key}）" });
            return new
            {
                RequestType = type,
                Label = type == ProcessBindings.Publication ? "发布申请" : "访问申请",
                ProcessKey = binding?.ProcessKey,
                ProcessName = published?.Name ?? definitions.FirstOrDefault(x => x.Key == binding?.ProcessKey)?.Name,
                PublishedVersion = published?.Version,
                Status = binding is null ? "未绑定" : published is null ? "无已发布版本" : "已生效",
                UpdatedAt = binding?.UpdatedAt,
                Options = options
            };
        }));
    }

    private static async Task<IResult> SaveBindingAsync(string requestType, BindInput input, ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var type = ProcessBindings.Normalize(requestType);
        var key = input.ProcessKey?.Trim() ?? "";
        var published = await db.ProcessDefinitions.OrderByDescending(x => x.Version)
            .FirstOrDefaultAsync(x => x.Key == key && x.IsPublished && x.RequestType == type, ct);
        if (published is null) return Results.BadRequest(new { message = "请选择适用于该申请类型且已有发布版本的流程" });
        var row = await db.RequestProcessBindings.SingleOrDefaultAsync(x => x.RequestType == type, ct);
        if (row is null) db.RequestProcessBindings.Add(row = new RequestProcessBinding { RequestType = type, ProcessKey = key });
        row.ProcessKey = key;
        row.UpdatedById = current.Id;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> EligibleAppsAsync(ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await LoadUserAsync(db, current.Id, ct);
        if (user is null) return Results.Forbid();
        var ready = await db.ApplicationRoutes.AsNoTracking().Where(x => x.Status == ApplicationRouteService.Ready).Select(x => x.PublicationRequestId).ToListAsync(ct);
        var personal = await ActiveGrantsAsync(db, user.Id, ct);
        var apps = await db.PublicationRequests.AsNoTracking().Include(x => x.AccessGrants)
            .Where(x => x.Status == PublicationStatus.Approved && x.OperationalEnabled && ready.Contains(x.Id)).ToListAsync(ct);
        var registered = await db.RegisteredApplications.AsNoTracking().Include(x => x.Grants)
            .Where(x => x.IsEnabled && x.AccessMode == "Subjects").ToListAsync(ct);
        var registeredGrants = await RegisteredApplicationAccess.ActiveGrants(db, user.Id)
            .Select(x => x.RegisteredApplicationId!.Value).ToListAsync(ct);
        var eligible = apps.Where(x => !PublishedApplicationAccess.HasScope(x, user, personal.Contains(x.Id)))
            .Select(x => new { x.Id, Name = x.AppName, Registered = false })
            .Concat(registered.Where(x => !RegisteredApplicationAccess.HasScope(x, user, registeredGrants.Contains(x.Id)))
                .Select(x => new { x.Id, x.Name, Registered = true }));
        return Results.Ok(eligible.OrderBy(x => x.Name));
    }

    private static async Task<IResult> MyAccessAsync(ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        Results.Ok(await db.ApplicationAccessRequests.AsNoTracking()
            .Where(x => x.ApplicantId == current.Id).OrderByDescending(x => x.CreatedAt)
            .Select(x => new { x.Id, x.RequestNo, x.PublicationRequestId, x.RegisteredApplicationId,
                AppName = x.Publication != null ? x.Publication.AppName : x.RegisteredApplication != null ? x.RegisteredApplication.Name : "",
                x.Reason, Status = x.Status.ToString(), x.CurrentNodeName, x.ReviewComment, x.CreatedAt, x.UpdatedAt }).ToListAsync(ct));

    private static async Task<IResult> ReviewableAccessAsync(ICurrentUser current, AigcHubDbContext db, WorkflowService workflow, CancellationToken ct)
    {
        var pending = await db.WorkflowTasks.AsNoTracking().Include(x => x.Candidates)
            .Where(x => x.Status == WorkflowTaskStatus.Pending).ToListAsync(ct);
        var visible = new List<Guid>();
        foreach (var task in pending)
            if (await workflow.CanHandleAsync(current.Id, task, ct)) visible.Add(task.InstanceId);
        var items = await db.ApplicationAccessRequests.AsNoTracking().Include(x => x.Applicant).Include(x => x.Publication).Include(x => x.RegisteredApplication)
            .Where(x => x.ProcessInstanceId != null && visible.Contains(x.ProcessInstanceId.Value)).OrderByDescending(x => x.CreatedAt).ToListAsync(ct);
        return Results.Ok(items.Select(x =>
        {
            var task = pending.First(t => t.InstanceId == x.ProcessInstanceId);
            return new
            {
                x.Id, x.RequestNo, x.Reason, Status = x.Status.ToString(), x.CurrentNodeName,
                ApplicantName = x.Applicant?.Name ?? "", ApplicantEmployeeNo = x.Applicant?.EmployeeNo ?? "",
                AppName = x.Publication?.AppName ?? x.RegisteredApplication?.Name ?? "", TaskId = task.Id, task.Name,
                Assignment = AssignmentLabel(task)
            };
        }));
    }

    private static async Task<IResult> AccessDetailAsync(Guid id, ICurrentUser current, AigcHubDbContext db, WorkflowService workflow, CancellationToken ct)
    {
        var request = await db.ApplicationAccessRequests.AsNoTracking().Include(x => x.Applicant).Include(x => x.Publication).Include(x => x.RegisteredApplication)
            .SingleOrDefaultAsync(x => x.Id == id, ct);
        if (request is null) return Results.NotFound();
        var allowed = request.ApplicantId == current.Id;
        WorkflowTask? task = null;
        if (request.ProcessInstanceId is Guid instanceId)
        {
            task = await db.WorkflowTasks.AsNoTracking().Include(x => x.Candidates)
                .Where(x => x.InstanceId == instanceId).OrderByDescending(x => x.CreatedAt).FirstOrDefaultAsync(ct);
            if (!allowed) allowed = task is not null && await workflow.CanHandleAsync(current.Id, task, ct);
        }
        if (!allowed) return Results.Forbid();
        var history = request.ProcessInstanceId is null ? [] : await db.WorkflowHistory.AsNoTracking()
            .Where(x => x.InstanceId == request.ProcessInstanceId).OrderBy(x => x.CreatedAt)
            .Select(x => new { x.EventType, x.NodeKey, x.Detail, x.CreatedAt, x.ActorId }).ToListAsync(ct);
        return Results.Ok(new
        {
            request.Id, request.RequestNo, request.Reason, Status = request.Status.ToString(), request.CurrentNodeName, request.ReviewComment,
            ApplicantName = request.Applicant?.Name ?? "", AppName = request.Publication?.AppName ?? request.RegisteredApplication?.Name ?? "",
            request.PublicationRequestId, request.RegisteredApplicationId, Assignment = AssignmentLabel(task), history
        });
    }

    private static async Task<IResult> SubmitAccessAsync(Guid applicationId, string reason, ICurrentUser current,
        WorkflowService workflow, CancellationToken ct, bool registered)
    {
        var item = await workflow.SubmitAccessAsync(current.Id, applicationId, reason, ct, registered);
        return Results.Ok(new { item.Id, item.RequestNo, Status = item.Status.ToString(), item.CurrentNodeName, item.CreatedAt });
    }

    private static async Task<IResult> LaunchAsync(Guid id, ICurrentUser current, LaunchTicketService tickets, IConfiguration configuration, CancellationToken ct)
    {
        var issued = await tickets.IssueAsync(current.Id, id, ct);
        var proxyHostSuffix = ApplicationGatewayHost.GetProxyHostSuffix(configuration);
        if (proxyHostSuffix is not null)
            return Results.Ok(new
            {
                ticket = issued.Token, slug = issued.Slug, expiresAt = issued.ExpiresAt,
                gatewayOrigin = $"https://{issued.Slug}.{proxyHostSuffix}", launchPath = ApplicationGatewayHost.ProxyLaunchPath
            });
        var origin = (configuration["ApplicationGateway:PublicOrigin"] ?? "").TrimEnd('/');
        if (string.IsNullOrEmpty(origin)) return Results.Problem("应用网关公开地址未配置", statusCode: 503);
        return Results.Ok(new { ticket = issued.Token, slug = issued.Slug, gatewayOrigin = origin, expiresAt = issued.ExpiresAt });
    }

    private static async Task<IResult> RevokeAsync(Guid id, RevokeInput input, ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var grant = await db.ApplicationPersonalGrants.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (grant is null) return Results.NotFound();
        if (grant.RevokedAt is null)
        {
            grant.RevokedAt = DateTimeOffset.UtcNow;
            grant.RevokedById = current.Id;
            grant.RevokeReason = string.IsNullOrWhiteSpace(input.Reason) ? "管理员撤销" : input.Reason.Trim();
            await db.SaveChangesAsync(ct);
        }
        return Results.NoContent();
    }

    private static string AssignmentLabel(WorkflowTask? task) => task?.Candidates.FirstOrDefault(x => x.Type == "source")?.Value switch
    {
        "owner" => "应用负责人",
        "fallback" => "兜底审核角色",
        _ => ""
    };

    private static Task<AppUser?> LoadUserAsync(AigcHubDbContext db, Guid id, CancellationToken ct) =>
        db.Users.AsNoTracking().Include(x => x.Roles).Include(x => x.Department).SingleOrDefaultAsync(x => x.Id == id && x.IsEnabled, ct);

    private static Task<List<Guid>> ActiveGrantsAsync(AigcHubDbContext db, Guid userId, CancellationToken ct) =>
        db.ApplicationPersonalGrants.AsNoTracking().Where(x => x.UserId == userId && x.RevokedAt == null && x.PublicationRequestId != null)
            .Select(x => x.PublicationRequestId!.Value).ToListAsync(ct);
}
