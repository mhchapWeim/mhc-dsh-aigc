using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

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
        processes.MapPost("/{id:guid}/publish", PublishAsync);
    }

    private static async Task<IResult> CreateAsync(SaveProcessDefinitionRequest input,
        AigcHubDbContext db, CancellationToken ct)
    {
        if (await db.ProcessDefinitions.AnyAsync(x => x.Key == input.Key && x.Version == input.Version, ct))
            return Results.Conflict(new { message = "流程版本已存在" });
        var item = new ProcessDefinition
        {
            Key = input.Key.Trim(), Name = input.Name.Trim(), Version = input.Version,
            DefinitionJson = input.Definition.GetRawText(), IsPublished = input.IsPublished
        };
        if (input.IsPublished)
        {
            var published = await db.ProcessDefinitions.Where(x => x.Key == item.Key && x.IsPublished).ToListAsync(ct);
            foreach (var sibling in published) sibling.IsPublished = false;
        }
        db.Add(item);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/process-definitions/{item.Id}", item);
    }

    private static async Task<IResult> PublishAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.ProcessDefinitions.FindAsync([id], ct);
        if (item is null) return Results.NotFound();
        var siblings = await db.ProcessDefinitions.Where(x => x.Key == item.Key).ToListAsync(ct);
        foreach (var sibling in siblings) sibling.IsPublished = sibling.Id == id;
        item.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
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
