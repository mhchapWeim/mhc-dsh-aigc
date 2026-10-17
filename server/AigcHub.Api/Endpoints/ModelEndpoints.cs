using AigcHub.Api.Contracts;
using AigcHub.Api.Services;
using AigcHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using AigcHub.Api.Domain;
using System.Text.Json;

namespace AigcHub.Api.Endpoints;

public static class ModelEndpoints
{
    public static void MapModelEndpoints(this IEndpointRouteBuilder app)
    {
        var models = app.MapGroup("/api/models").WithTags("模型管理").RequireAuthorization("model.manage");
        models.MapGet("/", async (ModelConfigurationService service, LiteLlmVirtualKeyService virtualKeys,
            CancellationToken ct) => Results.Ok(await service.AdminListAsync(virtualKeys, ct)));
        models.MapPost("/", SaveAsync);
        models.MapPut("/{id:guid}", UpdateAsync);
        models.MapDelete("/{id:guid}", DeleteAsync);
        models.MapPost("/{id:guid}/test", TestAsync);
        models.MapPost("/sync-litellm", async (LiteLlmModelSyncService service,
            CancellationToken ct) => Results.Ok(await service.SynchronizeAsync(ct)));
        models.MapGet("/eligible-users", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo)
                .Select(x => new { x.Id, x.EmployeeNo, x.Name }).ToArrayAsync(ct)));
        models.MapGet("/grant-options", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(new
        {
            users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo)
                .Select(x => new { x.Id, x.EmployeeNo, x.Name }).ToArrayAsync(ct),
            roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name).Select(x => new { x.Id, x.Code, x.Name }).ToArrayAsync(ct),
            departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
                .Select(x => new { x.Id, x.Code, x.Name }).ToArrayAsync(ct)
        }));
        models.MapGet("/{id:guid}/grants", async (Guid id, AigcHubDbContext db, AccessGrantService grants, CancellationToken ct) =>
        {
            if (!await db.ModelConfigurations.AnyAsync(x => x.Id == id, ct)) return Results.NotFound();
            var assigned = await grants.GetAsync(AccessGrantService.ModelKey(id), ct);
            var legacyUsers = await db.UserModelGrants.AsNoTracking().Where(x => x.ModelId == id).Select(x => x.UserId).ToArrayAsync(ct);
            return Results.Ok(assigned with { UserIds = assigned.UserIds.Concat(legacyUsers).Distinct().ToArray() });
        });
        models.MapPut("/{id:guid}/grants", async (Guid id, AccessGrantSelection input, AigcHubDbContext db,
            AccessGrantService grants, ICurrentUser current, CancellationToken ct) =>
        {
            var model = await db.ModelConfigurations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
            if (model is null) return Results.NotFound();
            await grants.SetAsync(AccessGrantService.ModelKey(id), input, ct);
            var legacy = await db.UserModelGrants.Where(x => x.ModelId == id).ToArrayAsync(ct);
            db.UserModelGrants.RemoveRange(legacy);
            db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "model.grants",
                EntityType = "Model", EntityId = id.ToString(), Succeeded = true,
                DetailJson = JsonSerializer.Serialize(new { model.Name, model.ModelIdentifier, userCount = input.UserIds.Length,
                    roleCount = input.RoleIds.Length, departmentCount = input.DepartmentIds.Length }) });
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });
        models.MapGet("/{id:guid}/users", async (Guid id, ModelConfigurationService service, CancellationToken ct) =>
            Results.Ok(await service.GrantedUserIdsAsync(id, ct)));
        models.MapPut("/{id:guid}/users", async (Guid id, Guid[] userIds, ModelConfigurationService service, CancellationToken ct) =>
        {
            await service.SetGrantedUsersAsync(id, userIds, ct);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> SaveAsync(SaveModelConfigurationRequest input, ModelConfigurationService service,
        AigcHubDbContext db, ICurrentUser current, CancellationToken ct)
    {
        var model = await service.SaveAsync(null, input, ct);
        await AuditAsync(db, current.Id, "model.create", model, ct);
        return Results.Ok(ModelConfigurationService.View(model));
    }

    private static async Task<IResult> UpdateAsync(Guid id, SaveModelConfigurationRequest input, ModelConfigurationService service,
        AigcHubDbContext db, ICurrentUser current, CancellationToken ct)
    {
        var previous = await db.ModelConfigurations.AsNoTracking().Where(x => x.Id == id)
            .Select(x => new { x.Name, x.ModelIdentifier, x.ProviderKind, x.IsEnabled }).SingleOrDefaultAsync(ct);
        var model = await service.SaveAsync(id, input, ct);
        await AuditAsync(db, current.Id, "model.update", model, ct, previous);
        return Results.Ok(ModelConfigurationService.View(model));
    }

    private static async Task<IResult> DeleteAsync(Guid id, ModelConfigurationService service,
        AigcHubDbContext db, ICurrentUser current, CancellationToken ct)
    {
        var model = await db.ModelConfigurations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct)
            ?? throw new WorkflowException("模型配置不存在", 404);
        await service.DeleteAsync(id, ct);
        await AuditAsync(db, current.Id, "model.delete", model, ct);
        return Results.NoContent();
    }

    private static async Task AuditAsync(AigcHubDbContext db, Guid actor, string action,
        AiModelConfiguration model, CancellationToken ct, object? previous = null)
    {
        db.OperationAudits.Add(new OperationAudit { UserId = actor, Action = action, EntityType = "Model",
            EntityId = model.Id.ToString(), Succeeded = true,
            DetailJson = JsonSerializer.Serialize(new { model.Name, model.ModelIdentifier, model.ProviderKind,
                model.IsEnabled, Previous = previous }) });
        await db.SaveChangesAsync(ct);
    }

    private static async Task<IResult> TestAsync(Guid id, ChatModelClient client, CancellationToken ct)
        => Results.Ok(new { message = await client.TestAsync(id, ct) });
}
