using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed class WorkflowDefinitionReader(AigcHubDbContext db)
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public async Task<WorkflowTask> CreateFirstUserTaskAsync(ProcessDefinition definition,
        Guid instanceId, Guid initiatorId, CancellationToken ct)
    {
        var document = Read(definition);
        var node = document.Nodes.FirstOrDefault(x => x.Type.Equals("userTask", StringComparison.OrdinalIgnoreCase))
            ?? throw new WorkflowException("已发布流程中没有用户任务节点", 409);
        return await CreateTaskAsync(node, instanceId, initiatorId, ct);
    }

    public async Task<WorkflowTask?> CreateNextUserTaskAsync(ProcessDefinition definition,
        Guid instanceId, Guid initiatorId, string currentNodeKey, CancellationToken ct)
    {
        var document = Read(definition);
        var currentIndex = Array.FindIndex(document.Nodes, x => x.Id == currentNodeKey);
        if (currentIndex < 0) throw new WorkflowException("当前流程节点不在已发布定义中", 409);
        var node = document.Nodes.Skip(currentIndex + 1)
            .FirstOrDefault(x => x.Type.Equals("userTask", StringComparison.OrdinalIgnoreCase));
        return node is null ? null : await CreateTaskAsync(node, instanceId, initiatorId, ct);
    }

    private static WorkflowDefinitionDocument Read(ProcessDefinition definition)
    {
        try
        {
            return JsonSerializer.Deserialize<WorkflowDefinitionDocument>(definition.DefinitionJson, JsonOptions)
                ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw new WorkflowException("已发布流程定义格式无效，请重新发布流程", 409);
        }
    }

    private async Task<WorkflowTask> CreateTaskAsync(WorkflowNodeDocument node,
        Guid instanceId, Guid initiatorId, CancellationToken ct)
    {
        var task = new WorkflowTask
        {
            InstanceId = instanceId,
            NodeKey = node.Id,
            Name = string.IsNullOrWhiteSpace(node.Name) ? "应用发布审核" : node.Name.Trim()
        };

        var candidates = new List<(string Type, string Value)>();
        if (node.Candidates is { Length: > 0 })
        {
            foreach (var candidate in node.Candidates)
            {
                var parts = candidate.Split(':', 2, StringSplitOptions.TrimEntries);
                if (parts.Length == 2) candidates.Add((parts[0].ToLowerInvariant(), parts[1]));
            }
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
        if (task.Candidates.Count == 0)
            throw new WorkflowException($"流程节点“{task.Name}”没有配置有效处理人", 409);
        return task;
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

    private sealed record WorkflowDefinitionDocument(WorkflowNodeDocument[] Nodes);
    private sealed record WorkflowNodeDocument(string Id, string Type, string? Name, string? AssignmentType,
        string? Assignee, string[]? AssigneeIds, string[]? Candidates);
}
