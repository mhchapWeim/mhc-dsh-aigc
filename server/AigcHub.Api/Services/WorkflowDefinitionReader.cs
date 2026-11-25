using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record AccessAssignment(Guid ApplicationId, bool Registered);

public sealed class WorkflowDefinitionReader(AigcHubDbContext db)
{
    public Task<WorkflowTask> CreateNodeTaskAsync(ProcessDefinition definition, string key, Guid instanceId, Guid initiatorId, CancellationToken ct) =>
        CreateTaskAsync(Read(definition).Nodes.Single(n => n.Id == key), instanceId, initiatorId, null, ct);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task<WorkflowTask> CreateFirstUserTaskAsync(ProcessDefinition definition,
        Guid instanceId, Guid initiatorId, CancellationToken ct, AccessAssignment? access = null)
    {
        var document = Read(definition);
        if (access is not null && document.Edges is { Length: > 0 })
        {
            var start = document.Nodes.FirstOrDefault(x => x.Type.Equals("start", StringComparison.OrdinalIgnoreCase))
                ?? throw new WorkflowException("访问申请流程缺少开始事件", 409);
            var first = FollowAccessRoute(document, start, "succeeded");
            if (!first.Type.Equals("userTask", StringComparison.OrdinalIgnoreCase))
                throw new WorkflowException("访问申请流程必须先经过审核任务", 409);
            return await CreateTaskAsync(first, instanceId, initiatorId, access, ct);
        }
        var node = document.Nodes.FirstOrDefault(x => x.Type.Equals("userTask", StringComparison.OrdinalIgnoreCase))
            ?? throw new WorkflowException("已发布流程中没有用户任务节点", 409);
        return await CreateTaskAsync(node, instanceId, initiatorId, access, ct);
    }

    public async Task<WorkflowTask?> CreateNextUserTaskAsync(ProcessDefinition definition,
        Guid instanceId, Guid initiatorId, string currentNodeKey, CancellationToken ct, bool accessApproval = false)
    {
        var document = Read(definition);
        var currentIndex = Array.FindIndex(document.Nodes, x => x.Id == currentNodeKey);
        if (currentIndex < 0) throw new WorkflowException("当前流程节点不在已发布定义中", 409);
        if (accessApproval && document.Edges is { Length: > 0 })
        {
            var target = FollowAccessRoute(document, document.Nodes[currentIndex], "passed");
            return target.Type.Equals("end", StringComparison.OrdinalIgnoreCase)
                ? null : await CreateTaskAsync(target, instanceId, initiatorId, null, ct);
        }
        var node = document.Nodes.Skip(currentIndex + 1)
            .FirstOrDefault(x => x.Type.Equals("userTask", StringComparison.OrdinalIgnoreCase));
        return node is null ? null : await CreateTaskAsync(node, instanceId, initiatorId, null, ct);
    }

    private static WorkflowNodeDocument FollowAccessRoute(WorkflowDefinitionDocument document, WorkflowNodeDocument current, string outcome)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (visited.Add(current.Id))
        {
            var outgoing = document.Edges!.Where(edge => edge.Source == current.Id).ToArray();
            var candidates = outgoing.Where(edge => AccessOutcome(edge) == outcome).ToArray();
            if (candidates.Length == 0)
                candidates = outgoing.Where(edge => AccessOutcome(edge) == "").ToArray();
            if (candidates.Length != 1)
                throw new WorkflowException($"访问申请流程节点“{current.Name ?? current.Id}”没有唯一的结果出口，请检查连线的结果条件", 409);
            current = document.Nodes.FirstOrDefault(node => node.Id == candidates[0].Target)
                ?? throw new WorkflowException("访问申请流程连线指向不存在的节点", 409);
            switch (current.Type.ToLowerInvariant())
            {
                case "usertask":
                case "end":
                    return current;
                case "gateway":
                    break;
                default:
                    throw new WorkflowException($"访问申请流程不支持执行节点“{current.Name ?? current.Id}”", 409);
            }
        }
        throw new WorkflowException("访问申请流程连线形成循环，请检查结果出口", 409);
    }

    private static string AccessOutcome(WorkflowEdgeDocument edge)
    {
        if (!string.IsNullOrWhiteSpace(edge.Outcome)) return edge.Outcome.Trim().ToLowerInvariant();
        // Older visual definitions may store the approval branches as standard labels only.
        return edge.Label?.Trim() switch
        {
            "审核通过" => "passed",
            "审核退回" or "审核不通过" => "rejected",
            _ => ""
        };
    }

    /// <summary>发布时确认应用负责人分配只出现在访问申请流程，且兜底角色编码真实存在。</summary>
    public async Task<string?> ValidatePublishedAssignmentsAsync(string requestType, string definitionJson, CancellationToken ct)
    {
        using var json = JsonDocument.Parse(definitionJson);
        if (!json.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array) return null;
        foreach (var node in nodes.EnumerateArray())
        {
            if (!node.TryGetProperty("type", out var type) || !string.Equals(type.GetString(), "userTask", StringComparison.OrdinalIgnoreCase)) continue;
            if (node.TryGetProperty("candidates", out var legacy) && legacy.ValueKind == JsonValueKind.Array && legacy.GetArrayLength() > 0) continue;
            if (!node.TryGetProperty("assignmentType", out var assignment) || !string.Equals(assignment.GetString(), "appOwner", StringComparison.OrdinalIgnoreCase)) continue;
            if (!string.Equals(requestType, ProcessBindings.Access, StringComparison.OrdinalIgnoreCase))
                return "分配方式「应用负责人（缺省转平台审核员）」只能用于访问申请流程";
            var role = node.TryGetProperty("fallbackRole", out var fallback) ? fallback.GetString()?.Trim() : null;
            if (string.IsNullOrWhiteSpace(role)) return "应用负责人分配必须选择兜底审核角色";
            if (!await db.Roles.AsNoTracking().AnyAsync(x => x.Code == role, ct))
                return "兜底审核角色不存在，请重新选择已有角色";
        }
        return null;
    }

    private static WorkflowDefinitionDocument Read(ProcessDefinition definition)
    {
        try
        {
            using var json = JsonDocument.Parse(definition.DefinitionJson);
            if (!IntegrationWorkflowRunner.IsIntegrated(definition) && json.RootElement.GetProperty("nodes").EnumerateArray().Any(n =>
                n.TryGetProperty("serviceCode", out var code) && !string.IsNullOrWhiteSpace(code.GetString())))
                throw new WorkflowException("流程配置了第三方服务但未启用第三方流程执行，请复制新版本并启用 integrated-v1 后发布", 409);
            return JsonSerializer.Deserialize<WorkflowDefinitionDocument>(definition.DefinitionJson, JsonOptions)
                ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new WorkflowException("已发布流程定义格式无效，请重新发布流程", 409);
        }
    }

    private async Task<WorkflowTask> CreateTaskAsync(WorkflowNodeDocument node,
        Guid instanceId, Guid initiatorId, AccessAssignment? access, CancellationToken ct)
    {
        var task = new WorkflowTask
        {
            InstanceId = instanceId,
            NodeKey = node.Id,
            Name = string.IsNullOrWhiteSpace(node.Name) ? "应用发布审核" : node.Name.Trim()
        };

        var candidates = new List<(string Type, string Value)>();
        string? source = null;
        if (node.Candidates is { Length: > 0 })
        {
            foreach (var candidate in node.Candidates)
            {
                var parts = candidate.Split(':', 2, StringSplitOptions.TrimEntries);
                if (parts.Length == 2) candidates.Add((parts[0].ToLowerInvariant(), parts[1]));
            }
        }
        else if (string.Equals(node.AssignmentType, "appOwner", StringComparison.OrdinalIgnoreCase))
        {
            access ??= await LoadAccessAssignmentAsync(instanceId, ct);
            source = await AddApplicationOwnerCandidatesAsync(task.Name, node, initiatorId, access, candidates, ct);
        }
        else
        {
            switch (node.AssignmentType?.ToLowerInvariant())
            {
                case "users":
                    foreach (var value in node.AssigneeIds ?? []) candidates.Add(("user", value));
                    break;
                case "department":
                    if (!string.IsNullOrWhiteSpace(node.Assignee)) candidates.Add(("department", node.Assignee));
                    break;
                case "role":
                    if (!string.IsNullOrWhiteSpace(node.Assignee)) candidates.Add(("role", node.Assignee));
                    break;
                case "initiator":
                    candidates.Add(("user", initiatorId.ToString()));
                    break;
            }
        }

        foreach (var candidate in await NormalizeCandidatesAsync(candidates, ct))
            task.Candidates.Add(new WorkflowTaskCandidate { Type = candidate.Type, Value = candidate.Value });
        if (source is not null)
            task.Candidates.Add(new WorkflowTaskCandidate { Type = "source", Value = source });
        if (!task.Candidates.Any(x => x.Type is "user" or "department" or "role"))
            throw new WorkflowException($"流程节点“{task.Name}”没有配置有效处理人", 409);
        return task;
    }

    private async Task<AccessAssignment?> LoadAccessAssignmentAsync(Guid instanceId, CancellationToken ct)
    {
        var instance = await db.WorkflowInstances.AsNoTracking()
            .Where(x => x.Id == instanceId)
            .Select(x => new { x.BusinessType, x.BusinessId })
            .FirstOrDefaultAsync(ct);
        if (instance is null || instance.BusinessType != ProcessBindings.AccessBusiness) return null;
        var request = await db.ApplicationAccessRequests.AsNoTracking()
            .Where(x => x.Id == instance.BusinessId)
            .Select(x => new { x.PublicationRequestId, x.RegisteredApplicationId })
            .FirstOrDefaultAsync(ct);
        if (request?.RegisteredApplicationId is Guid registered) return new AccessAssignment(registered, true);
        if (request?.PublicationRequestId is Guid published) return new AccessAssignment(published, false);
        return null;
    }

    /// <summary>
    /// 负责人存在、启用且不是申请人时只派给该人；否则派给兜底角色里除申请人以外的启用成员。
    /// 候选人在此刻写死，之后修改负责人不影响这张待办。
    /// </summary>
    private async Task<string> AddApplicationOwnerCandidatesAsync(string nodeName, WorkflowNodeDocument node,
        Guid initiatorId, AccessAssignment? access, List<(string Type, string Value)> candidates, CancellationToken ct)
    {
        if (access is null) throw new WorkflowException($"流程节点“{nodeName}”的应用负责人分配只能用于访问申请", 409);
        Guid? reviewerId = access.Registered
            ? await db.RegisteredApplications.AsNoTracking().Where(x => x.Id == access.ApplicationId).Select(x => x.AccessReviewerId).FirstOrDefaultAsync(ct)
            : await db.PublicationRequests.AsNoTracking().Where(x => x.Id == access.ApplicationId).Select(x => x.AccessReviewerId).FirstOrDefaultAsync(ct);
        if (reviewerId is Guid ownerId && ownerId != initiatorId)
        {
            var owner = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == ownerId && x.IsEnabled, ct);
            if (owner is not null)
            {
                candidates.Add(("user", owner.Id.ToString()));
                return "owner";
            }
        }
        var roleCode = node.FallbackRole?.Trim();
        if (string.IsNullOrWhiteSpace(roleCode))
            throw new WorkflowException($"流程节点“{nodeName}”未配置兜底审核角色", 409);
        if (!await db.Roles.AsNoTracking().AnyAsync(x => x.Code == roleCode, ct))
            throw new WorkflowException($"流程节点“{nodeName}”的兜底审核角色不存在", 409);
        var members = await db.Users.AsNoTracking()
            .Where(x => x.IsEnabled && x.Id != initiatorId && x.Roles.Any(role => role.Role.Code == roleCode))
            .Select(x => x.Id)
            .ToListAsync(ct);
        if (members.Count == 0)
            throw new WorkflowException($"流程节点“{nodeName}”的兜底审核角色没有可用成员", 409);
        foreach (var member in members.Distinct()) candidates.Add(("user", member.ToString()));
        return "fallback";
    }

    private async Task<IReadOnlyList<(string Type, string Value)>> NormalizeCandidatesAsync(
        IEnumerable<(string Type, string Value)> candidates, CancellationToken ct)
    {
        var result = new List<(string Type, string Value)>();
        foreach (var (rawType, rawValue) in candidates)
        {
            var type = rawType.Trim().ToLowerInvariant();
            var value = rawValue.Trim();
            if (type == "role")
            {
                var role = await db.Roles.AsNoTracking().FirstOrDefaultAsync(x => x.Code == value || x.Name == value, ct);
                if (role is not null) result.Add((type, role.Code));
            }
            else if (type == "department")
            {
                var department = await db.Departments.AsNoTracking().FirstOrDefaultAsync(x => x.Code == value || x.Name == value, ct);
                if (department is not null) result.Add((type, department.Code));
            }
            else if (type == "user")
            {
                AppUser? user = null;
                if (Guid.TryParse(value, out var id))
                    user = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id && x.IsEnabled, ct);
                else
                    user = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.EmployeeNo == value && x.IsEnabled, ct);
                if (user is not null) result.Add((type, user.Id.ToString()));
            }
        }
        return result.Distinct().ToArray();
    }

    private sealed record WorkflowDefinitionDocument(WorkflowNodeDocument[] Nodes, WorkflowEdgeDocument[]? Edges);
    private sealed record WorkflowEdgeDocument(string Source, string Target, string? Outcome, string? Label);
    private sealed record WorkflowNodeDocument(string Id, string Type, string? Name, string? AssignmentType,
        string? Assignee, string[]? AssigneeIds, string[]? Candidates, string? FallbackRole);
}
