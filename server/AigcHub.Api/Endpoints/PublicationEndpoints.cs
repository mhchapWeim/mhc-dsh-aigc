using System.Text.Json;
using System.Text.Json.Nodes;
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
            Results.Ok(await db.Categories.AsNoTracking().Where(x => x.IsEnabled && (x.ParentId == null || x.Parent!.IsEnabled)).OrderBy(x => x.SortOrder)
                .Select(x => new { x.Id, x.Code, x.Name, x.Description, x.ParentId }).ToListAsync(ct)))
            .RequireAuthorization("publication.create");
        publications.MapGet("/types", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.ProcessDefinitions.AsNoTracking().Where(x => x.IsPublished)
                .OrderBy(x => x.Name).Select(x => new { code = x.Key, name = x.Name, x.Version }).ToListAsync(ct)))
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
            .RequireAuthorization();
        tasks.MapGet("/mine", MyTasksAsync).RequireAuthorization("publication.review");
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
        var requestedTaskIds = !mine
            ? await db.WorkflowTasks.AsNoTracking()
                .Where(x => instanceIds.Contains(x.InstanceId))
                .Select(x => new { x.InstanceId, x.Name, x.Status, x.CreatedAt })
                .ToListAsync(ct)
            : [];
        var subscriptions = await db.CallbackSubscriptions.AsNoTracking()
            .Where(x => instanceIds.Contains(x.InstanceId) && !x.IsConsumed)
            .ToDictionaryAsync(x => x.InstanceId, x => x.CorrelationId, ct);
        // Service results live in the instance variables; reviewers need them to judge the case.
        var instanceVariables = await db.WorkflowInstances.AsNoTracking()
            .Where(x => instanceIds.Contains(x.Id))
            .Select(x => new { x.Id, x.VariablesJson })
            .ToListAsync(ct);
        var reviewerIds = requests.Where(x => x.ReviewerId.HasValue).Select(x => x.ReviewerId!.Value).Distinct().ToArray();
        var reviewers = reviewerIds.Length == 0 ? [] : await db.Users.AsNoTracking()
            .Where(x => reviewerIds.Contains(x.Id)).Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        // The applicant stores only stable subject ids; reviewers judge scope from these resolved labels.
        var grantLabels = await ResolveAccessLabelsAsync(db, requests, ct);
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
            var reviewerName = item.ReviewerId.HasValue
                ? reviewers.FirstOrDefault(x => x.Id == item.ReviewerId.Value)?.Name ?? "" : "";
            var taskName = !mine
                ? requestedTaskIds
                    .Where(x => x.InstanceId == item.ProcessInstanceId && x.Status == WorkflowTaskStatus.Completed)
                    .OrderByDescending(x => x.CreatedAt).Select(x => x.Name).FirstOrDefault()
                : null;
            // The front end must not infer the assignment state from arrays it cannot see; the
            // open task already carries who may act on it.
            var (scope, assignee) = DescribeCandidates(task);
            items.Add(new PublicationView(item.Id, item.RequestNo, item.AppName, item.Category?.Name ?? "",
                item.Summary, item.AccessUrl, item.Applicant?.Name ?? "", item.Applicant?.Department?.Name ?? "",
                item.Status.ToString(), item.CurrentNodeKey, item.CurrentNodeName, item.CreatedAt, item.UpdatedAt,
                item.ReviewComment, task?.Id, actions.ToArray(),
                item.ProcessInstanceId.HasValue && subscriptions.TryGetValue(item.ProcessInstanceId.Value, out var correlation)
                    ? correlation : null,
                item.RepositoryUrl, item.Branch, item.CommitSha, item.Version, item.Environment,
                item.AccessMode, DescribeAccessMode(item, grantLabels), reviewerName, taskName,
                scope, assignee,
                item.ProcessInstanceId.HasValue
                    ? ExtractAudit(instanceVariables.FirstOrDefault(x => x.Id == item.ProcessInstanceId.Value)?.VariablesJson)
                    : null));
        }
        return new PageResult<PublicationView>(items, page, pageSize, total);
    }

    /// <summary>
    /// Pull the audit verdict out of the instance variables. Service nodes persist their
    /// callback payload under variables.nodes[nodeKey]; the reviewer opens DetailUrl to read
    /// the full third-party report and decides from it.
    /// </summary>
    private static AuditSummaryView? ExtractAudit(string? variablesJson)
    {
        if (string.IsNullOrWhiteSpace(variablesJson)) return null;
        try
        {
            if (JsonNode.Parse(variablesJson) is not JsonObject variables) return null;
            if (variables["nodes"] is not JsonObject nodes) return null;
            foreach (var (nodeKey, value) in nodes.Where(x => x.Value is JsonObject).OrderByDescending(x => DateTimeOffset.TryParse(x.Value?["finishedAt"]?.ToString(), out var time) ? time : DateTimeOffset.MinValue))
            {
                if (value is not JsonObject payload) continue;
                var decision = payload["decision"]?.ToString();
                var status = payload["executionStatus"]?.ToString();
                // Only nodes that actually returned a verdict are worth showing.
                if (string.IsNullOrEmpty(decision) && string.IsNullOrEmpty(status)) continue;
                // Third parties name the report link differently; accept the common spellings.
                var detailUrl = IntegrationWorkflowRunner.Text(payload, "detailUrl") is { Length: > 0 } primary ? primary
                    : IntegrationWorkflowRunner.Text(payload, "reportUrl") is { Length: > 0 } report ? report
                    : IntegrationWorkflowRunner.Text(payload, "auditUrl") is { Length: > 0 } audit ? audit
                    : IntegrationWorkflowRunner.Text(payload, "reportPageUrl") is { Length: > 0 } page ? page : null;
                var issues = payload["issues"] is JsonArray array ? array.Count.ToString() : null;
                if (!Uri.TryCreate(detailUrl, UriKind.Absolute, out var link) || link.Scheme != "https" || !string.IsNullOrEmpty(link.UserInfo)) detailUrl = null;
                var nodeName = IntegrationWorkflowRunner.Text(payload, "nodeName");
                var summary = IntegrationWorkflowRunner.Text(payload, "summary");
                var commit = IntegrationWorkflowRunner.Text(payload, "commitSha");
                return new AuditSummaryView(nodeKey, nodeName.Length > 0 ? nodeName : nodeKey, decision, summary,
                    detailUrl, commit.Length > 0 ? commit : null, status, issues,
                    payload["verdict"]?.ToString(), payload["riskLevel"]?.ToString(), payload["taskId"]?.ToString(), payload["finishedAt"]?.ToString(),
                    payload["errorCode"]?.ToString(), payload["retryable"] is JsonValue retry && retry.TryGetValue<bool>(out var retryable) ? retryable : null,
                    payload["repositoryFullName"]?.ToString(), payload["reviewerSubject"]?.ToString());
            }
            return null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Report the pending task's handling rule in words. A null task means the node is not
    /// waiting on a person at all (publishing / finished), which is not the same as "no candidate".
    /// </summary>
    private static (string Scope, string? AssigneeId) DescribeCandidates(WorkflowTask? task)    {
        if (task is null) return ("", null);
        if (task.AssigneeId.HasValue) return ("指定处理人", task.AssigneeId.Value.ToString());
        if (task.Candidates.Count == 0) return ("待分配", null);
        if (task.Candidates.Any(x => x.Type == "user")) return ("指定处理人", null);
        if (task.Candidates.Any(x => x.Type == "role")) return ("候选用户组", null);
        return ("候选部门", null);
    }

    private static async Task<Dictionary<Guid, string[]>> ResolveAccessLabelsAsync(AigcHubDbContext db,
        IEnumerable<PublicationRequest> requests, CancellationToken ct)
    {
        var requested = requests.Where(x => x.AccessGrants.Count > 0).Select(x => x.Id).ToArray();
        if (requested.Length == 0) return [];
        var grants = await db.PublicationAccessGrants.AsNoTracking()
            .Where(x => requested.Contains(x.PublicationRequestId)).ToListAsync(ct);
        var userIds = grants.Where(x => x.SubjectType == "User").Select(x => x.SubjectId).Distinct().ToArray();
        var departmentIds = grants.Where(x => x.SubjectType == "Department").Select(x => x.SubjectId).Distinct().ToArray();
        var roleIds = grants.Where(x => x.SubjectType == "Role").Select(x => x.SubjectId).Distinct().ToArray();
        var users = userIds.Length == 0 ? [] : await db.Users.AsNoTracking().Where(x => userIds.Contains(x.Id))
            .Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        var departments = departmentIds.Length == 0 ? [] : await db.Departments.AsNoTracking()
            .Where(x => departmentIds.Contains(x.Id)).Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        var roles = roleIds.Length == 0 ? [] : await db.Roles.AsNoTracking()
            .Where(x => roleIds.Contains(x.Id)).Select(x => new { x.Id, x.Name }).ToListAsync(ct);
        string Label(string type, Guid id) => type switch
        {
            "User" => users.FirstOrDefault(x => x.Id == id)?.Name ?? "已删除用户",
            "Department" => departments.FirstOrDefault(x => x.Id == id)?.Name ?? "已删除部门",
            "Role" => roles.FirstOrDefault(x => x.Id == id)?.Name ?? "已删除角色",
            _ => "未知"
        };
        return grants.GroupBy(x => x.PublicationRequestId).ToDictionary(
            group => group.Key,
            group => group.Select(x => Label(x.SubjectType, x.SubjectId)).Distinct().ToArray());
    }

    /// <summary>Human-readable access scope; reviewers must not have to guess from a raw enum.</summary>
    private static string DescribeAccessMode(PublicationRequest item, Dictionary<Guid, string[]> labels)
    {
        if (!string.Equals(item.AccessMode, "Subjects", StringComparison.OrdinalIgnoreCase)) return "所有已登录用户";
        return labels.TryGetValue(item.Id, out var names) && names.Length > 0
            ? string.Join("、", names)
            : "指定可访问人（未配置）";
    }
}
