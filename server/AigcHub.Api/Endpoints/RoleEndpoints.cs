using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class RoleEndpoints
{
    public static void MapRoleEndpoints(this IEndpointRouteBuilder app)
    {
        var roles = app.MapGroup("/api/roles").WithTags("角色管理").RequireAuthorization("role.manage");
        roles.MapGet("/permissions", async (AigcHubDbContext db, CancellationToken ct) =>
            Results.Ok(await db.Permissions.AsNoTracking().OrderBy(x => x.PagePath).ToListAsync(ct)));
        roles.MapGet("/", ListAsync);
        roles.MapPost("/", CreateAsync);
        roles.MapPut("/{id:guid}", UpdateAsync);
        roles.MapDelete("/{id:guid}", DeleteAsync);
    }

    private static async Task<IResult> ListAsync(int page, int pageSize, AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var query = db.Roles.AsNoTracking().Include(x => x.Permissions).ThenInclude(x => x.Permission).Include(x => x.Users);
        var total = await query.CountAsync(ct);
        var items = await query.OrderBy(x => x.Name).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new
            {
                x.Id, x.Code, x.Name, x.Description, x.IsBuiltIn, UserCount = x.Users.Count,
                Permissions = x.Permissions.Select(p => p.Permission.Code)
            }).ToListAsync(ct);
        return Results.Ok(new PageResult<object>(items.Cast<object>().ToList(), page, pageSize, total));
    }

    private static async Task<IResult> CreateAsync(SaveRoleRequest input, AigcHubDbContext db, CancellationToken ct)
    {
        if (await db.Roles.AnyAsync(x => x.Code == input.Code || x.Name == input.Name, ct))
            return Results.Conflict(new { message = "角色编码或名称已存在" });
        var permissions = await db.Permissions.Where(x => input.PermissionCodes.Contains(x.Code)).ToListAsync(ct);
        var role = new Role { Code = input.Code.Trim(), Name = input.Name.Trim(), Description = input.Description.Trim() };
        role.Permissions = permissions.Select(x => new RolePermission { Role = role, Permission = x }).ToList();
        db.Roles.Add(role);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/roles/{role.Id}", new { role.Id });
    }

    private static async Task<IResult> UpdateAsync(Guid id, SaveRoleRequest input, AigcHubDbContext db, CancellationToken ct)
    {
        var role = await db.Roles.Include(x => x.Permissions).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (role is null) return Results.NotFound();
        if (await db.Roles.AnyAsync(x => x.Id != id && (x.Code == input.Code || x.Name == input.Name), ct))
            return Results.Conflict(new { message = "角色编码或名称已存在" });
        var permissions = await db.Permissions.Where(x => input.PermissionCodes.Contains(x.Code)).ToListAsync(ct);
        role.Code = input.Code.Trim();
        role.Name = input.Name.Trim();
        role.Description = input.Description.Trim();
        db.RolePermissions.RemoveRange(role.Permissions);
        role.Permissions = permissions.Select(x => new RolePermission { Role = role, Permission = x }).ToList();
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> DeleteAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var role = await db.Roles.Include(x => x.Users).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (role is null) return Results.NotFound();
        if (role.IsBuiltIn || role.Users.Count > 0)
            return Results.Conflict(new { message = "内置角色或仍有关联用户的角色不能删除" });
        db.Roles.Remove(role);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
