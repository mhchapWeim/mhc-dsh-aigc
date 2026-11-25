using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AigcHub.Api.Endpoints;

public static class ProcessEndpoints
{
    public static void MapProcessEndpoints(this IEndpointRouteBuilder app)
    {
        var processes = app.MapGroup("/api/process-definitions").WithTags("流程设计")
            .RequireAuthorization("process.design");
        processes.MapGet("/designer-options", DesignerOptionsAsync);
        processes.MapGet("/", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.ProcessDefinitions.AsNoTracking().OrderBy(x => x.Key)
                .ThenByDescending(x => x.Version).ToListAsync(ct)));
        processes.MapPost("/", CreateAsync);
        processes.MapPut("/{id:guid}", UpdateAsync);
        processes.MapPost("/{id:guid}/publish", PublishAsync);
        processes.MapPost("/{id:guid}/disable", DisableAsync);
    }

    public sealed record UpdateInput(string Name, JsonElement Definition, DateTimeOffset ExpectedUpdatedAt);
    public sealed record PublishInput(DateTimeOffset ExpectedUpdatedAt);

    // PostgreSQL stores microseconds; return exactly the precision persisted so
    // the next optimistic-concurrency token survives a database round trip.
    private static DateTimeOffset Timestamp()
    {
        var now = DateTimeOffset.UtcNow;
        return new DateTimeOffset(now.Ticks - now.Ticks % 10, TimeSpan.Zero);
    }

    // Every mutation of a process key uses the same transaction lock. Different
    // processes remain independent; version allocation and publishing are atomic.
    private static async Task<IDbContextTransaction?> LockAsync(AigcHubDbContext db, string key, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return null;
        var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({key}))", ct);
        return transaction;
    }

    private static string? Validate(string name, JsonElement definition, bool publish)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 150) return "流程名称不能为空且不能超过 150 个字符";
        if (definition.ValueKind != JsonValueKind.Object || !definition.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            return "流程定义必须包含节点数组";
        var ids = new HashSet<string>();
        var types = new Dictionary<string, string>();
        foreach (var node in nodes.EnumerateArray())
        {
            if (node.ValueKind != JsonValueKind.Object || !node.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(id.GetString()) || !ids.Add(id.GetString()!)) return "节点 ID 不能为空或重复";
            if (!node.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String
                || type.GetString() is not ("start" or "end" or "userTask" or "serviceTask" or "gateway")) return "节点类型无效";
            types[id.GetString()!] = type.GetString()!;
            if (publish && (!node.TryGetProperty("name", out var label) || label.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(label.GetString())))
                return "存在未命名节点";
        }
        if (!publish) return null;
        if (types.Values.Count(x => x == "start") != 1 || !types.ContainsValue("end")) return "流程必须包含一个开始事件和至少一个结束事件";
        // Legacy definitions run in their stored node order and have no edges.
        if (!definition.TryGetProperty("edges", out var edges)) return AigcHub.Api.Services.IntegrationDefinitionValidator.Validate(System.Text.Json.Nodes.JsonNode.Parse(definition.GetRawText())!);
        if (edges.ValueKind != JsonValueKind.Array) return "流程连线格式无效";
        var links = new List<(string Source, string Target)>();
        foreach (var edge in edges.EnumerateArray())
        {
            if (edge.ValueKind != JsonValueKind.Object || !edge.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.String
                || !edge.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.String) return "流程连线格式无效";
            var a = source.GetString()!; var b = target.GetString()!;
            if (!ids.Contains(a) || !ids.Contains(b) || a == b || types[a] == "end" || types[b] == "start" || links.Contains((a, b))) return "流程包含无效连线";
            links.Add((a, b));
        }
        var reached = new HashSet<string> { types.First(x => x.Value == "start").Key };
        while (links.Any(x => reached.Contains(x.Source) && !reached.Contains(x.Target)))
            foreach (var link in links.Where(x => reached.Contains(x.Source)).ToArray()) reached.Add(link.Target);
        if (reached.Count != ids.Count) return "存在无法从开始事件到达的节点";
        var finishable = types.Where(x => x.Value == "end").Select(x => x.Key).ToHashSet();
        while (links.Any(x => finishable.Contains(x.Target) && !finishable.Contains(x.Source)))
            foreach (var link in links.Where(x => finishable.Contains(x.Target)).ToArray()) finishable.Add(link.Source);
        if (finishable.Count != ids.Count) return "存在无法到达结束事件的节点";
        return AigcHub.Api.Services.IntegrationDefinitionValidator.Validate(System.Text.Json.Nodes.JsonNode.Parse(definition.GetRawText())!);
    }

    private static async Task<IResult> CreateAsync(SaveProcessDefinitionRequest input,
        AigcHubDbContext db, WorkflowDefinitionReader reader, CancellationToken ct)
    {
        var key = input.Key?.Trim() ?? "";
        if (!Regex.IsMatch(key, "^[a-z][a-z0-9-]{1,79}$")) return Results.BadRequest(new { message = "流程编码需为 2–80 位小写字母、数字或连字符，以字母开头" });
        var error = Validate(input.Name, input.Definition, input.IsPublished);
        if (error is not null) return Results.BadRequest(new { message = error });
        var requestType = string.IsNullOrWhiteSpace(input.RequestType) ? "publication" : input.RequestType.Trim().ToLowerInvariant();
        if (requestType is not ("publication" or "access")) return Results.BadRequest(new { message = "流程适用的申请类型必须是 publication 或 access" });
        await using var transaction = await LockAsync(db, key, ct);
        var siblings = await db.ProcessDefinitions.Where(x => x.Key == key).ToListAsync(ct);
        if (siblings.Count > 0)
            requestType = siblings[0].RequestType;
        if (siblings.Any(x => x.RequestType != requestType)) return Results.BadRequest(new { message = "同一流程编码只能适用于一种申请类型" });
        if (input.IsPublished)
        {
            var assignmentError = await reader.ValidatePublishedAssignmentsAsync(requestType, input.Definition.GetRawText(), ct);
            if (assignmentError is not null) return Results.BadRequest(new { message = assignmentError });
        }
        var version = input.Version > 0 ? input.Version : siblings.Select(x => x.Version).DefaultIfEmpty(0).Max() + 1;
        if (siblings.Any(x => x.Version == version)) return Results.Conflict(new { message = "流程版本已存在，请刷新后重试" });
        var now = Timestamp();
        var item = new ProcessDefinition
        {
            Key = key, Name = input.Name.Trim(), Version = version, RequestType = requestType,
            DefinitionJson = input.Definition.GetRawText(), IsPublished = input.IsPublished,
            PublishedAt = input.IsPublished ? now : null, UpdatedAt = now,
        };
        if (input.IsPublished) foreach (var sibling in siblings.Where(x => x.IsPublished))
        {
            sibling.PublishedAt ??= sibling.UpdatedAt;
            sibling.IsPublished = false;
        }
        db.Add(item);
        await db.SaveChangesAsync(ct);
        if (transaction is not null) await transaction.CommitAsync(ct);
        return Results.Created($"/api/process-definitions/{item.Id}", item);
    }

    private static async Task<IResult> UpdateAsync(Guid id, UpdateInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var key = await db.ProcessDefinitions.Where(x => x.Id == id).Select(x => x.Key).SingleOrDefaultAsync(ct);
        if (key is null) return Results.NotFound();
        await using var transaction = await LockAsync(db, key, ct);
        var item = await db.ProcessDefinitions.SingleAsync(x => x.Id == id, ct);
        if (item.IsPublished || item.PublishedAt is not null || await db.WorkflowInstances.AnyAsync(x => x.ProcessDefinitionId == id, ct))
            return Results.Conflict(new { message = "已发布或已使用的版本不可修改，请复制为新版本" });
        if (item.UpdatedAt != input.ExpectedUpdatedAt) return Results.Conflict(new { message = "草稿已被其他人修改，请重新打开后再编辑" });
        var error = Validate(input.Name, input.Definition, false);
        if (error is not null) return Results.BadRequest(new { message = error });
        item.Name = input.Name.Trim(); item.DefinitionJson = input.Definition.GetRawText();
        var now = Timestamp(); item.UpdatedAt = now > item.UpdatedAt ? now : item.UpdatedAt.AddTicks(10);
        await db.SaveChangesAsync(ct);
        if (transaction is not null) await transaction.CommitAsync(ct);
        return Results.Ok(item);
    }

    private static async Task<IResult> PublishAsync(Guid id, PublishInput? input, AigcHubDbContext db, WorkflowDefinitionReader reader, CancellationToken ct)
    {
        var key = await db.ProcessDefinitions.Where(x => x.Id == id).Select(x => x.Key).SingleOrDefaultAsync(ct);
        if (key is null) return Results.NotFound();
        await using var transaction = await LockAsync(db, key, ct);
        var siblings = await db.ProcessDefinitions.Where(x => x.Key == key).ToListAsync(ct);
        var item = siblings.Single(x => x.Id == id);
        if (input is not null && item.UpdatedAt != input.ExpectedUpdatedAt)
            return Results.Conflict(new { message = "草稿在发布前已被其他人修改，请重新打开核对后再发布" });
        using var document = JsonDocument.Parse(item.DefinitionJson);
        var error = Validate(item.Name, document.RootElement, true);
        if (error is not null) return Results.BadRequest(new { message = error });
        var assignmentError = await reader.ValidatePublishedAssignmentsAsync(item.RequestType, item.DefinitionJson, ct);
        if (assignmentError is not null) return Results.BadRequest(new { message = assignmentError });
        foreach (var sibling in siblings)
        {
            if (sibling.IsPublished) sibling.PublishedAt ??= sibling.UpdatedAt;
            sibling.IsPublished = sibling.Id == id;
        }
        item.PublishedAt ??= Timestamp();
        item.UpdatedAt = Timestamp();
        await db.SaveChangesAsync(ct);
        if (transaction is not null) await transaction.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> DisableAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var key = await db.ProcessDefinitions.Where(x => x.Id == id).Select(x => x.Key).SingleOrDefaultAsync(ct);
        if (key is null) return Results.NotFound();
        await using var transaction = await LockAsync(db, key, ct);
        var item = await db.ProcessDefinitions.SingleAsync(x => x.Id == id, ct);
        if (item.IsPublished) { item.PublishedAt ??= item.UpdatedAt; item.IsPublished = false; item.UpdatedAt = Timestamp(); }
        await db.SaveChangesAsync(ct);
        if (transaction is not null) await transaction.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> DesignerOptionsAsync(AigcHubDbContext db, CancellationToken ct)
    {
        var users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo)
            .Select(x => new { value = x.Id.ToString(), label = x.Name, x.EmployeeNo }).ToListAsync(ct);
        var departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
            .Select(x => new { value = x.Code, label = x.Name }).ToListAsync(ct);
        var roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name)
            .Select(x => new { value = x.Code, label = x.Name }).ToListAsync(ct);
        return Results.Ok(new { users, departments, roles });
    }
}
