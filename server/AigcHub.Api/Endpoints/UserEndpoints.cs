using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class UserEndpoints
{
    private sealed record ResetPasswordInput(string NewPassword);
    public static void MapUserEndpoints(this IEndpointRouteBuilder app)
    {
        var users = app.MapGroup("/api/users").WithTags("用户管理").RequireAuthorization("user.manage");
        users.MapGet("/", ListAsync);
        users.MapGet("/access-options", UserAccessAdministration.OptionsAsync);
        users.MapPost("/", CreateAsync);
        users.MapPut("/{id:guid}", UpdateAsync);
        users.MapPut("/{id:guid}/password", ResetPasswordAsync);
    }

    private static async Task<IResult> ResetPasswordAsync(Guid id, ResetPasswordInput input, ICurrentUser current,
        AigcHubDbContext db, IPasswordHasher<AppUser> hasher, CancellationToken ct)
    {
        var user = await db.Users.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (user is null) return Results.NotFound();
        await UserPasswordService.ApplyAsync(user, input.NewPassword, db, hasher, ct);
        db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "user.password-reset", EntityType = "AppUser", EntityId = id.ToString(), Succeeded = true });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ListAsync(int page, int pageSize, string? keyword,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var query = db.Users.AsNoTracking().Include(x => x.Department).Include(x => x.Roles)
            .ThenInclude(x => x.Role).AsQueryable();
        if (!string.IsNullOrWhiteSpace(keyword))
            query = query.Where(x => x.Name.Contains(keyword) || x.EmployeeNo.Contains(keyword) || x.Email.Contains(keyword));
        var total = await query.CountAsync(ct);
        var items = await query.OrderBy(x => x.EmployeeNo).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new
            {
                x.Id, x.EmployeeNo, x.Name, x.Email, x.DepartmentId,
                Department = x.Department == null ? "" : x.Department.Name, x.IsEnabled, x.LastLoginAt,
                Roles = x.Roles.Select(r => new { r.RoleId, r.Role.Name })
            }).ToListAsync(ct);
        return Results.Ok(new PageResult<object>(items.Cast<object>().ToList(), page, pageSize, total));
    }

    private static async Task<IResult> CreateAsync(SaveUserRequest input, AigcHubDbContext db,
        IPasswordHasher<AppUser> hasher, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        if (await db.Users.AnyAsync(x => x.EmployeeNo == input.EmployeeNo || x.Email == input.Email, ct))
            return Results.Conflict(new { message = "工号或邮箱已存在" });
        if (input.DepartmentId.HasValue && !await db.Departments.AnyAsync(x => x.Id == input.DepartmentId, ct))
            return Results.BadRequest(new { message = "部门不存在" });
        var roles = await db.Roles.Where(x => input.RoleIds.Contains(x.Id)).ToListAsync(ct);
        var user = new AppUser
        {
            EmployeeNo = input.EmployeeNo.Trim(), Name = input.Name.Trim(), Email = input.Email.Trim(),
            DepartmentId = input.DepartmentId, PasswordHash = "", IsEnabled = input.IsEnabled
        };
        user.PasswordHash = hasher.HashPassword(user, string.IsNullOrWhiteSpace(input.Password) ? "Bhss@123" : input.Password);
        user.Roles = roles.Select(x => new UserRole { User = user, Role = x }).ToList();
        await UserAccessAdministration.ApplyAsync(db, user.Id, input, ct);
        db.Users.Add(user);
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.Created($"/api/users/{user.Id}", new { user.Id });
    }

    private static async Task<IResult> UpdateAsync(Guid id, SaveUserRequest input, AigcHubDbContext db,
        IPasswordHasher<AppUser> hasher, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var user = await db.Users.Include(x => x.Roles).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (user is null) return Results.NotFound();
        if (await db.Users.AnyAsync(x => x.Id != id && (x.EmployeeNo == input.EmployeeNo || x.Email == input.Email), ct))
            return Results.Conflict(new { message = "工号或邮箱已存在" });
        var roles = await db.Roles.Where(x => input.RoleIds.Contains(x.Id)).ToListAsync(ct);
        if (input.DepartmentId.HasValue && !await db.Departments.AnyAsync(x => x.Id == input.DepartmentId, ct))
            return Results.BadRequest(new { message = "部门不存在" });
        await UserAccessAdministration.ApplyAsync(db, user.Id, input, ct);
        user.EmployeeNo = input.EmployeeNo.Trim();
        user.Name = input.Name.Trim();
        user.Email = input.Email.Trim();
        user.DepartmentId = input.DepartmentId;
        user.IsEnabled = input.IsEnabled;
        if (!string.IsNullOrWhiteSpace(input.Password)) await UserPasswordService.ApplyAsync(user, input.Password, db, hasher, ct);
        db.UserRoles.RemoveRange(user.Roles);
        user.Roles = roles.Select(x => new UserRole { User = user, Role = x }).ToList();
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.NoContent();
    }
}
