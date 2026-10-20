using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

namespace AigcHub.Api.Endpoints;

public static class VirtualKeyEndpoints
{
    private sealed record CreateKeyInput(string Alias, string? CustomKey, VirtualKeyPolicy? Policy = null);
    private sealed record KeyGrantsInput(Guid[] UserIds, Guid[] DepartmentIds, Guid[] OrganizationIds, Guid[]? RoleIds = null);
    private sealed record OrganizationInput(string Name, Guid[] UserIds);
    private sealed record ToolAuditInput(string SessionId, string CallId, string ToolName, bool Succeeded, string? ErrorCode);

    public static void MapVirtualKeyEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/virtual-keys").RequireAuthorization("model.manage").WithTags("LiteLLM 虚拟 Key");
        group.MapGet("/", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(
            await db.ManagedVirtualKeys.AsNoTracking().OrderBy(x => x.Alias)
                .Select(x => new { x.Id, x.Alias, x.IsEnabled, x.CreatedAt }).ToArrayAsync(ct)));
        group.MapPost("/", CreateAsync);
        group.MapPut("/{id:guid}/enabled", SetEnabledAsync);
        group.MapGet("/{id:guid}/grants", GetGrantsAsync);
        group.MapPut("/{id:guid}/grants", SetGrantsAsync);
        group.MapGet("/grant-options", async (Guid? keyId, AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await VirtualKeyGrantRules.GrantOptionsAsync(db, keyId, ct)));
        group.MapGet("/model-options", async (LiteLlmVirtualKeyService service, CancellationToken ct) =>
            Results.Ok(await service.PolicyModelOptionsAsync(ct)));
        group.MapGet("/{id:guid}/policy", async (Guid id, AigcHubDbContext db, LiteLlmVirtualKeyService service, CancellationToken ct) =>
        {
            var key = await db.ManagedVirtualKeys.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
            return key is null ? Results.NotFound() : Results.Ok(await service.GetPolicyAsync(key.KeyProtected, ct));
        });
        group.MapPut("/{id:guid}/policy", UpdatePolicyAsync);
        group.MapGet("/organizations", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(
            await db.VirtualKeyOrganizations.AsNoTracking().OrderBy(x => x.Name)
                .Select(x => new { x.Id, x.Name, userIds = db.VirtualKeyOrganizationMembers.Where(m => m.OrganizationId == x.Id)
                    .Select(m => m.UserId).ToArray() }).ToArrayAsync(ct)));
        group.MapPost("/organizations", CreateOrganizationAsync);
        group.MapPut("/organizations/{id:guid}", UpdateOrganizationAsync);
        app.MapGet("/api/operation-audits", async (int? page, int? pageSize, AigcHubDbContext db, CancellationToken ct) =>
        {
            var number = Math.Clamp(page ?? 1, 1, 100000);
            pageSize = Math.Clamp(pageSize ?? 5, 1, 100);
            var size = pageSize.Value;
            var total = await db.OperationAudits.AsNoTracking().CountAsync(ct);
            var items = await (from audit in db.OperationAudits.AsNoTracking()
                join user in db.Users.AsNoTracking() on audit.UserId equals user.Id into actors
                from actor in actors.DefaultIfEmpty()
                orderby audit.CreatedAt descending, audit.Id descending
                select new { audit.Id, audit.UserId, ActorName = actor == null ? "已删除用户" : actor.Name,
                    audit.Action, audit.EntityType, audit.EntityId, audit.DetailJson,
                    audit.Succeeded, audit.CreatedAt })
                .Skip((number - 1) * size).Take(size).ToArrayAsync(ct);
            var users = await db.Users.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
            var departments = await db.Departments.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
            var organizations = await db.VirtualKeyOrganizations.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
            var keys = await db.ManagedVirtualKeys.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Alias, ct);
            var models = await db.ModelConfigurations.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
            var displayItems = items.Select(audit => new {
                audit.Id, audit.UserId, audit.ActorName, audit.Action, audit.EntityType, audit.EntityId,
                audit.DetailJson, audit.Succeeded, audit.CreatedAt,
                ActionLabel = AuditActionLabel(audit.Action),
                EntityLabel = AuditEntityLabel(audit.Action, audit.EntityType, audit.EntityId, audit.DetailJson, keys, organizations, models),
                DetailLabel = AuditDetailLabel(audit.Action, audit.DetailJson, users, departments, organizations)
            }).ToArray();
            return Results.Ok(new { items = displayItems, total, page = number, pageSize });
        }).RequireAuthorization("model.manage").WithTags("操作审计");
        app.MapPost("/v1/tool-audits", WriteToolAuditAsync).WithTags("DSH 操作审计");
    }

    private static async Task<IResult> CreateAsync(CreateKeyInput input, ICurrentUser current,
        AigcHubDbContext db, LiteLlmVirtualKeyService service, CancellationToken ct)
    {
        var alias = input.Alias.Trim();
        if (alias.Length is < 2 or > 100) throw new WorkflowException("Key 别名长度须为 2–100 字符", 400);
        if (await db.ManagedVirtualKeys.AnyAsync(x => x.Alias == alias, ct)) throw new WorkflowException("Key 别名已存在", 409);
        if (input.CustomKey is { Length: > 0 } custom && (!custom.StartsWith("sk-", StringComparison.Ordinal) || custom.Length < 16))
            throw new WorkflowException("自定义 Key 须以 sk- 开头，长度至少 16 字符", 400);
        var protectedKey = await service.CreateAsync(alias, input.CustomKey, ct, input.Policy);
        var entity = new ManagedVirtualKey { Alias = alias, KeyProtected = protectedKey };
        db.ManagedVirtualKeys.Add(entity);
        Audit(db, current.Id, "virtual-key.create", entity.Id.ToString(), new { alias, input.Policy });
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { entity.Id, entity.Alias, entity.IsEnabled });
    }

    private static async Task<IResult> UpdatePolicyAsync(Guid id, VirtualKeyPolicy input, ICurrentUser current,
        AigcHubDbContext db, LiteLlmVirtualKeyService service, CancellationToken ct)
    {
        var key = await db.ManagedVirtualKeys.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (key is null) return Results.NotFound();
        await service.UpdatePolicyAsync(key.KeyProtected, input, ct);
        Audit(db, current.Id, "virtual-key.policy", id.ToString(), new { key.Alias, policy = input });
        await db.SaveChangesAsync(ct);
        return Results.Ok(await service.GetPolicyAsync(key.KeyProtected, ct));
    }

    private static async Task<IResult> SetEnabledAsync(Guid id, bool enabled, ICurrentUser current,
        AigcHubDbContext db, LiteLlmVirtualKeyService service, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var key = await db.ManagedVirtualKeys.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (key is null) return Results.NotFound();
        if (enabled) await VirtualKeyGrantRules.AssertExclusiveAsync(db, id, ct);
        if (key.IsEnabled == enabled) return Results.NoContent();
        await service.SetBlockedAsync(key.KeyProtected, !enabled, ct);
        key.IsEnabled = enabled;
        Audit(db, current.Id, "virtual-key.enabled", id.ToString(), new { key.Alias, enabled });
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> GetGrantsAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        if (!await db.ManagedVirtualKeys.AnyAsync(x => x.Id == id, ct)) return Results.NotFound();
        var grants = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey == KeyResource(id)).ToArrayAsync(ct);
        return Results.Ok(new KeyGrantsInput(
            grants.Where(x => x.SubjectType == "User").Select(x => x.SubjectId).ToArray(),
            grants.Where(x => x.SubjectType == "Department").Select(x => x.SubjectId).ToArray(),
            grants.Where(x => x.SubjectType == "Organization").Select(x => x.SubjectId).ToArray(),
            grants.Where(x => x.SubjectType == "Role").Select(x => x.SubjectId).ToArray()));
    }

    private static async Task<IResult> SetGrantsAsync(Guid id, KeyGrantsInput input, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var key = await db.ManagedVirtualKeys.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (key is null) return Results.NotFound();
        var users = input.UserIds.Distinct().ToArray();
        var departments = input.DepartmentIds.Distinct().ToArray();
        var organizations = input.OrganizationIds.Distinct().ToArray();
        var roles = (input.RoleIds ?? []).Distinct().ToArray();
        if (await db.Users.CountAsync(x => users.Contains(x.Id) && x.IsEnabled, ct) != users.Length
            || await db.Departments.CountAsync(x => departments.Contains(x.Id) && x.IsEnabled, ct) != departments.Length
            || await db.VirtualKeyOrganizations.CountAsync(x => organizations.Contains(x.Id), ct) != organizations.Length
            || await db.Roles.CountAsync(x => roles.Contains(x.Id), ct) != roles.Length)
            throw new WorkflowException("授权范围包含不存在或已停用的对象", 400);
        await VirtualKeyGrantRules.AssertExclusiveAsync(db, id, ct, new(users, departments, organizations, roles));
        var desired = users.Select(x => (Type: "User", Id: x))
            .Concat(departments.Select(x => (Type: "Department", Id: x)))
            .Concat(roles.Select(x => (Type: "Role", Id: x)))
            .Concat(organizations.Select(x => (Type: "Organization", Id: x))).ToHashSet();
        var existing = await db.AccessGrants.Where(x => x.ResourceKey == KeyResource(id)).ToArrayAsync(ct);
        db.AccessGrants.RemoveRange(existing.Where(x => !desired.Contains((x.SubjectType, x.SubjectId))));
        db.AccessGrants.AddRange(desired.Except(existing.Select(x => (x.SubjectType, x.SubjectId)))
            .Select(x => new AccessGrant { ResourceKey = KeyResource(id), SubjectType = x.Item1, SubjectId = x.Item2 }));
        var userNames = await db.Users.AsNoTracking().Where(x => users.Contains(x.Id)).OrderBy(x => x.Name).Select(x => x.Name).ToArrayAsync(ct);
        var departmentNames = await db.Departments.AsNoTracking().Where(x => departments.Contains(x.Id)).OrderBy(x => x.Name).Select(x => x.Name).ToArrayAsync(ct);
        var organizationNames = await db.VirtualKeyOrganizations.AsNoTracking().Where(x => organizations.Contains(x.Id)).OrderBy(x => x.Name).Select(x => x.Name).ToArrayAsync(ct);
        Audit(db, current.Id, "virtual-key.grants", id.ToString(), new {
            key.Alias, users, departments, roles, organizations, userNames, departmentNames, organizationNames
        });
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> CreateOrganizationAsync(OrganizationInput input, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var name = input.Name.Trim();
        var users = input.UserIds.Distinct().ToArray();
        if (name.Length is < 2 or > 100) throw new WorkflowException("组织名称长度须为 2–100 字符", 400);
        if (await db.VirtualKeyOrganizations.AnyAsync(x => x.Name == name, ct))
            throw new WorkflowException("组织名称已存在", 409);
        if (await db.Users.CountAsync(x => users.Contains(x.Id) && x.IsEnabled, ct) != users.Length)
            throw new WorkflowException("组织包含不存在或已停用的用户", 400);
        await AssertOrganizationUsersAsync(db, null, users, ct);
        var org = new VirtualKeyOrganization { Name = name };
        db.VirtualKeyOrganizations.Add(org);
        db.VirtualKeyOrganizationMembers.AddRange(users.Select(x => new VirtualKeyOrganizationMember { OrganizationId = org.Id, UserId = x }));
        var userNames = await db.Users.AsNoTracking().Where(x => users.Contains(x.Id)).OrderBy(x => x.Name).Select(x => x.Name).ToArrayAsync(ct);
        Audit(db, current.Id, "virtual-key.organization.create", org.Id.ToString(), new { name, users, userNames });
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.Ok(new { org.Id, org.Name, userIds = users });
    }

    private static async Task<IResult> UpdateOrganizationAsync(Guid id, OrganizationInput input, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var org = await db.VirtualKeyOrganizations.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (org is null) return Results.NotFound();
        var name = input.Name.Trim();
        var users = input.UserIds.Distinct().ToArray();
        if (name.Length is < 2 or > 100) throw new WorkflowException("组织名称长度须为 2–100 字符", 400);
        if (await db.VirtualKeyOrganizations.AnyAsync(x => x.Id != id && x.Name == name, ct))
            throw new WorkflowException("组织名称已存在", 409);
        if (await db.Users.CountAsync(x => users.Contains(x.Id) && x.IsEnabled, ct) != users.Length)
            throw new WorkflowException("组织包含不存在或已停用的用户", 400);
        await AssertOrganizationUsersAsync(db, id, users, ct);
        var affected = await db.AccessGrants.AsNoTracking().Where(x => x.SubjectType == "Organization" && x.SubjectId == id
            && x.ResourceKey.StartsWith("virtual-key:")).Select(x => x.ResourceKey).ToArrayAsync(ct);
        foreach (var resource in affected)
            if (Guid.TryParse(resource["virtual-key:".Length..], out var keyId))
                await VirtualKeyGrantRules.AssertExclusiveAsync(db, keyId, ct, organizationId: id, organizationUsers: users);
        var previousName = org.Name;
        org.Name = name;
        var existing = await db.VirtualKeyOrganizationMembers.Where(x => x.OrganizationId == id).ToArrayAsync(ct);
        db.VirtualKeyOrganizationMembers.RemoveRange(existing.Where(x => !users.Contains(x.UserId)));
        db.VirtualKeyOrganizationMembers.AddRange(users.Except(existing.Select(x => x.UserId))
            .Select(x => new VirtualKeyOrganizationMember { OrganizationId = id, UserId = x }));
        var userNames = await db.Users.AsNoTracking().Where(x => users.Contains(x.Id)).OrderBy(x => x.Name).Select(x => x.Name).ToArrayAsync(ct);
        Audit(db, current.Id, "virtual-key.organization.update", id.ToString(), new { name, previousName, users, userNames });
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task AssertOrganizationUsersAsync(AigcHubDbContext db, Guid? id, Guid[] users, CancellationToken ct)
    {
        var conflict = await (from member in db.VirtualKeyOrganizationMembers.AsNoTracking()
            join organization in db.VirtualKeyOrganizations.AsNoTracking() on member.OrganizationId equals organization.Id
            where member.OrganizationId != id && users.Contains(member.UserId)
            select organization.Name).FirstOrDefaultAsync(ct);
        if (conflict is not null) throw new WorkflowException($"所选用户已在“{conflict}”分组中，请先移除原分组成员", 409);
    }

    private static string KeyResource(Guid id) => $"virtual-key:{id:D}";

    private static async Task<IResult> WriteToolAuditAsync(ToolAuditInput input, HttpRequest request,
        AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (input.SessionId.Length is < 1 or > 100 || input.CallId.Length is < 1 or > 100
            || input.ToolName.Length is < 1 or > 100 || input.ErrorCode?.Length > 100)
            return Results.BadRequest(new { error = "invalid tool audit" });
        var eventId = $"{input.SessionId}:{input.CallId}";
        if (await db.OperationAudits.AnyAsync(x => x.UserId == user.Id && x.EntityType == "DshTool" && x.EntityId == eventId, ct))
            return Results.NoContent();
        db.OperationAudits.Add(new OperationAudit { UserId = user.Id, Action = input.ToolName,
            EntityType = "DshTool", EntityId = eventId, Succeeded = input.Succeeded,
            DetailJson = JsonSerializer.Serialize(new { input.ErrorCode }) });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static void Audit(AigcHubDbContext db, Guid actor, string action, string id, object detail) =>
        db.OperationAudits.Add(new OperationAudit { UserId = actor, Action = action, EntityType = "ManagedVirtualKey",
            EntityId = id, DetailJson = JsonSerializer.Serialize(detail), Succeeded = true });

    private static string AuditActionLabel(string action) => action switch
    {
        "user.password" => "修改本人密码",
        "user.password-reset" => "管理员修改用户密码",
        "virtual-key.policy" => "修改虚拟 Key 套餐规则",
        "virtual-key.create" => "创建虚拟 Key",
        "virtual-key.enabled" => "切换虚拟 Key 状态",
        "virtual-key.grants" => "修改虚拟 Key 授权",
        "virtual-key.organization.create" => "创建授权组织",
        "virtual-key.organization.update" => "修改授权组织",
        "model.create" => "创建模型",
        "model.update" => "修改模型",
        "model.delete" => "删除模型",
        "model.grants" => "修改模型授权",
        "web-search.configure" => "配置网页搜索",
        "web_search" => "执行网页搜索",
        _ => action
    };

    private static string AuditEntityLabel(string action, string type, string? id, string json,
        IReadOnlyDictionary<Guid, string> keys, IReadOnlyDictionary<Guid, string> organizations,
        IReadOnlyDictionary<Guid, string> models)
    {
        if (action.StartsWith("virtual-key.organization.", StringComparison.Ordinal))
        {
            var snapshotName = AuditString(json, "name");
            if (snapshotName is not null) return $"授权组织：{snapshotName}";
            return id is not null && Guid.TryParse(id, out var orgId) && organizations.TryGetValue(orgId, out var orgName)
                ? $"授权组织：{orgName}" : "授权组织（已删除）";
        }
        if (type == "ManagedVirtualKey")
        {
            var snapshotAlias = AuditString(json, "Alias") ?? AuditString(json, "alias");
            if (snapshotAlias is not null) return $"虚拟 Key：{snapshotAlias}";
            return id is not null && Guid.TryParse(id, out var keyId) && keys.TryGetValue(keyId, out var alias)
                ? $"虚拟 Key：{alias}" : "虚拟 Key（已删除）";
        }
        if (type == "Model")
        {
            var snapshotName = AuditString(json, "Name");
            if (snapshotName is not null) return $"模型：{snapshotName}";
            return id is not null && Guid.TryParse(id, out var modelId) && models.TryGetValue(modelId, out var modelName)
                ? $"模型：{modelName}" : "模型（已删除）";
        }
        return type switch
        {
            "DshTool" => "DSH 工具调用",
            "ChatTool" => "AIGC 工具调用",
            "WebSearch" => "网页搜索配置",
            _ => type
        };
    }

    private static string? AuditString(string json, string field)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty(field, out var value)
                && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        }
        catch (JsonException) { return null; }
    }

    private static string AuditDetailLabel(string action, string json,
        IReadOnlyDictionary<Guid, string> users, IReadOnlyDictionary<Guid, string> departments,
        IReadOnlyDictionary<Guid, string> organizations)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var detail = document.RootElement;
            if (detail.ValueKind != JsonValueKind.Object) return "—";
            if (action == "virtual-key.grants")
            {
                var parts = new[] {
                    AuditNames(detail, "users", "userNames", "用户", users),
                    AuditNames(detail, "departments", "departmentNames", "部门", departments),
                    AuditNames(detail, "organizations", "organizationNames", "组织", organizations)
                }.Where(x => x is not null).ToArray();
                return parts.Length == 0 ? "已清空授权" : string.Join("；", parts);
            }
            if (action is "model.create" or "model.update" or "model.delete")
            {
                var parts = new List<string>();
                if (detail.TryGetProperty("ModelIdentifier", out var identifier) && identifier.ValueKind == JsonValueKind.String)
                    parts.Add($"模型标识：{identifier.GetString()}");
                if (detail.TryGetProperty("ProviderKind", out var provider) && provider.ValueKind == JsonValueKind.String)
                    parts.Add($"接入类型：{provider.GetString()}");
                if (detail.TryGetProperty("Previous", out var previous) && previous.ValueKind == JsonValueKind.Object)
                {
                    if (previous.TryGetProperty("Name", out var oldName) && oldName.ValueKind == JsonValueKind.String
                        && detail.TryGetProperty("Name", out var newName) && oldName.GetString() != newName.GetString())
                        parts.Add($"名称：{oldName.GetString()} → {newName.GetString()}");
                    if (previous.TryGetProperty("ModelIdentifier", out var oldIdentifier) && oldIdentifier.ValueKind == JsonValueKind.String
                        && detail.TryGetProperty("ModelIdentifier", out var newIdentifier) && oldIdentifier.GetString() != newIdentifier.GetString())
                        parts.Add($"原模型标识：{oldIdentifier.GetString()}");
                }
                return parts.Count > 0 ? string.Join("；", parts) : "—";
            }
            if (action == "model.grants")
            {
                var parts = new List<string>();
                if (detail.TryGetProperty("userCount", out var userCount)) parts.Add($"用户 {userCount.GetInt32()} 人");
                if (detail.TryGetProperty("roleCount", out var roleCount)) parts.Add($"角色 {roleCount.GetInt32()} 个");
                if (detail.TryGetProperty("departmentCount", out var departmentCount)) parts.Add($"部门 {departmentCount.GetInt32()} 个");
                return parts.Count > 0 ? string.Join("；", parts) : "—";
            }
            if (action.StartsWith("virtual-key.organization.", StringComparison.Ordinal))
            {
                var parts = new List<string>();
                if (detail.TryGetProperty("previousName", out var previousName) && previousName.ValueKind == JsonValueKind.String
                    && detail.TryGetProperty("name", out var currentName) && currentName.ValueKind == JsonValueKind.String
                    && previousName.GetString() != currentName.GetString())
                    parts.Add($"名称：{previousName.GetString()} → {currentName.GetString()}");
                var members = AuditNames(detail, "users", "userNames", "成员", users);
                if (members is not null) parts.Add(members);
                return parts.Count > 0 ? string.Join("；", parts) : "无成员";
            }
            if (action == "web-search.configure")
            {
                var parts = new List<string>();
                if (detail.TryGetProperty("IsEnabled", out var active) && active.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    parts.Add(active.GetBoolean() ? "已启用" : "已停用");
                if (detail.TryGetProperty("userCount", out var userCount)) parts.Add($"用户 {userCount.GetInt32()} 人");
                if (detail.TryGetProperty("roleCount", out var roleCount)) parts.Add($"角色 {roleCount.GetInt32()} 个");
                if (detail.TryGetProperty("departmentCount", out var departmentCount)) parts.Add($"部门 {departmentCount.GetInt32()} 个");
                return parts.Count > 0 ? string.Join("；", parts) : "—";
            }
            if (detail.TryGetProperty("Message", out var message) && message.ValueKind == JsonValueKind.String)
                return message.GetString() ?? "—";
            if ((detail.TryGetProperty("alias", out var alias) || detail.TryGetProperty("Alias", out alias))
                && alias.ValueKind == JsonValueKind.String)
                return $"别名：{alias.GetString()}";
            if (detail.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
                return $"名称：{name.GetString()}";
            if (detail.TryGetProperty("enabled", out var enabled) && enabled.ValueKind is JsonValueKind.True or JsonValueKind.False)
                return enabled.GetBoolean() ? "已启用" : "已停用";
            if (detail.TryGetProperty("ErrorCode", out var errorCode) && errorCode.ValueKind == JsonValueKind.String)
                return $"错误：{errorCode.GetString()}";
        }
        catch (JsonException) { /* Legacy malformed detail remains hidden rather than rendered as raw JSON. */ }
        return "—";
    }

    private static string? AuditNames(JsonElement detail, string field, string snapshotField, string label,
        IReadOnlyDictionary<Guid, string> names)
    {
        if (detail.TryGetProperty(snapshotField, out var snapshot) && snapshot.ValueKind == JsonValueKind.Array)
        {
            var labels = snapshot.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                .Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)).ToArray();
            return labels.Length == 0 ? null : $"{label}：{string.Join("、", labels)}";
        }
        if (!detail.TryGetProperty(field, out var values) || values.ValueKind != JsonValueKind.Array) return null;
        var selected = values.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => Guid.TryParse(x.GetString(), out var id) && names.TryGetValue(id, out var name)
                ? name : "已删除").ToArray();
        return selected.Length == 0 ? null : $"{label}：{string.Join("、", selected)}";
    }
}
