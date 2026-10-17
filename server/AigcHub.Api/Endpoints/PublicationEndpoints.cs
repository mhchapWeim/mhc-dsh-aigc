using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class PublicationEndpoints
{
    public static void MapPublicationEndpoints(this IEndpointRouteBuilder app)
    {
        var publications = app.MapGroup("/api/publication-requests").WithTags("应用发布")
            .RequireAuthorization();
        publications.MapGet("/options", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.Categories.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.SortOrder)
                .Select(x => new { x.Id, x.Code, x.Name, x.Description }).ToListAsync(ct)))
            .RequireAuthorization("publication.create");
        publications.MapGet("/access-options", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(new
            {
                Users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).Include(x => x.Department)
                    .OrderBy(x => x.Name).Select(x => new { x.Id, x.Name, x.EmployeeNo, Department = x.Department != null ? x.Department.Name : "" }).ToListAsync(ct),
                Departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
                    .Select(x => new { x.Id, x.Name }).ToListAsync(ct),
                Roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name).Select(x => new { x.Id, x.Name }).ToListAsync(ct)
            })).RequireAuthorization("publication.create");
        publications.MapGet("/mine", async (int page, int pageSize, ICurrentUser current,
            AigcHubDbContext db, WorkflowService workflow, CancellationToken ct) =>
            Results.Ok(await PublicationPageAsync(db, workflow, current.Id, true, page, pageSize, ct)))
            .RequireAuthorization("publication.create");
        publications.MapGet("/reviewable", async (int page, int pageSize, ICurrentUser current,
            AigcHubDbContext db, WorkflowService workflow, CancellationToken ct) =>
            Results.Ok(await PublicationPageAsync(db, workflow, current.Id, false, page, pageSize, ct)))
            .RequireAuthorization("publication.review");
        publications.MapPost("/", SubmitAsync).RequireAuthorization("publication.create");
        publications.MapPost("/{id:guid}/resubmit", ResubmitAsync).RequireAuthorization("publication.create");

        var tasks = app.MapGroup("/api/workflow/tasks").WithTags("流程任务")
            .RequireAuthorization("publication.review");
        tasks.MapGet("/mine", MyTasksAsync);
        tasks.MapPost("/{id:guid}/complete", async (Guid id, CompleteTaskRequest input,
            ICurrentUser current, WorkflowService workflow, CancellationToken ct) =>
            Results.Ok(await workflow.CompleteTaskAsync(current.Id, id, input, ct)));
    }

    private static async Task<IResult> SubmitAsync(SubmitPublicationRequest input,
        ICurrentUser current, WorkflowService workflow, CancellationToken ct)
    {
        var item = await workflow.SubmitAsync(current.Id, input, ct);
        return Results.Ok(new
        {
            item.Id, item.RequestNo, Status = item.Status.ToString(), item.CurrentNodeKey,
            item.CurrentNodeName, item.CreatedAt
        });
    }

    private static async Task<IResult> ResubmitAsync(Guid id, ICurrentUser current,
        WorkflowService workflow, CancellationToken ct)
    {
        var item = await workflow.ResubmitAsync(current.Id, id, ct);
        return Results.Ok(new
        {
            item.Id, item.RequestNo, Status = item.Status.ToString(), item.CurrentNodeKey,
            item.CurrentNodeName, item.UpdatedAt
        });
    }

    private static async Task<IResult> MyTasksAsync(ICurrentUser current, AigcHubDbContext db,
        WorkflowService workflow, CancellationToken ct)
    {
        var pending = await db.WorkflowTasks.AsNoTracking().Include(x => x.Candidates)
            .Where(x => x.Status == WorkflowTaskStatus.Pending).OrderByDescending(x => x.CreatedAt).ToListAsync(ct);
        var result = new List<object>();
        foreach (var task in pending)
            if (await workflow.CanHandleAsync(current.Id, task, ct))
                result.Add(new { task.Id, task.InstanceId, task.NodeKey, task.Name, task.CreatedAt });
        return Results.Ok(result);
    }

    private static async Task<PageResult<PublicationView>> PublicationPageAsync(AigcHubDbContext db,
        WorkflowService workflow, Guid actorId, bool mine, int page, int pageSize, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var query = db.PublicationRequests.AsNoTracking().Include(x => x.Category)
            .Include(x => x.Applicant).ThenInclude(x => x!.Department).AsQueryable();
        if (mine)
        {
            query = query.Where(x => x.ApplicantId == actorId);
        }
        else
        {
            var actor = await db.Users.AsNoTracking().Include(x => x.Department).Include(x => x.Roles)
                .ThenInclude(x => x.Role).SingleAsync(x => x.Id == actorId && x.IsEnabled, ct);
            var roleCodes = actor.Roles.Select(x => x.Role.Code).ToArray();
            var departmentCode = actor.Department?.Code;
            var actorValue = actor.Id.ToString();
            var eligibleInstances = db.WorkflowTasks.AsNoTracking()
                .Where(x => x.Status == WorkflowTaskStatus.Pending && x.Candidates.Any(candidate =>
                    (candidate.Type == "user" && candidate.Value == actorValue) ||
                    (candidate.Type == "department" && candidate.Value == departmentCode) ||
                    (candidate.Type == "role" && roleCodes.Contains(candidate.Value))))
                .Select(x => x.InstanceId);
            query = query.Where(x => x.ApplicantId != actorId && x.ProcessInstanceId.HasValue &&
                eligibleInstances.Contains(x.ProcessInstanceId.Value));
        }
        var total = await query.CountAsync(ct);
        var requests = await query.OrderByDescending(x => x.CreatedAt).Skip((page - 1) * pageSize)
            .Take(pageSize).ToListAsync(ct);
        var instanceIds = requests.Where(x => x.ProcessInstanceId.HasValue)
            .Select(x => x.ProcessInstanceId!.Value).ToArray();
        var openTasks = await db.WorkflowTasks.AsNoTracking().Include(x => x.Candidates)
            .Where(x => instanceIds.Contains(x.InstanceId) && x.Status == WorkflowTaskStatus.Pending).ToListAsync(ct);
        var subscriptions = await db.CallbackSubscriptions.AsNoTracking()
            .Where(x => instanceIds.Contains(x.InstanceId) && !x.IsConsumed)
            .ToDictionaryAsync(x => x.InstanceId, x => x.CorrelationId, ct);
        var items = new List<PublicationView>();
        foreach (var item in requests)
        {
            var task = openTasks.FirstOrDefault(x => x.InstanceId == item.ProcessInstanceId);
            var actions = new List<AvailableAction>();
            if (task is not null && await workflow.CanHandleAsync(actorId, task, ct))
            {
                actions.Add(new("approve", "通过"));
                actions.Add(new("reject", "退回"));
            }
            if (mine && item.ApplicantId == actorId && item.Status == PublicationStatus.Rejected)
                actions.Add(new("resubmit", "重新提交"));
            items.Add(new PublicationView(item.Id, item.RequestNo, item.AppName, item.Category?.Name ?? "",
                item.Summary, item.AccessUrl, item.Applicant?.Name ?? "", item.Applicant?.Department?.Name ?? "",
                item.Status.ToString(), item.CurrentNodeKey, item.CurrentNodeName, item.CreatedAt, item.UpdatedAt,
                item.ReviewComment, task?.Id, actions.ToArray(),
                item.ProcessInstanceId.HasValue && subscriptions.TryGetValue(item.ProcessInstanceId.Value, out var correlation)
                    ? correlation : null));
        }
        return new PageResult<PublicationView>(items, page, pageSize, total);
    }
}
