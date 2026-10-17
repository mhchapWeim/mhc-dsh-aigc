using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record AccessGrantSelection(Guid[] UserIds, Guid[] RoleIds, Guid[] DepartmentIds);

public sealed class AccessGrantService(AigcHubDbContext db)
{
    public static string ModelKey(Guid modelId) => $"model:{modelId:D}";
    public const string WebSearchKey = "web-search";

    public async Task<bool> AllowsAsync(string resourceKey, Guid userId, CancellationToken ct)
    {
        return await db.Users.AsNoTracking().AnyAsync(user => user.Id == userId && user.IsEnabled &&
            db.AccessGrants.Any(grant => grant.ResourceKey == resourceKey &&
                ((grant.SubjectType == "User" && grant.SubjectId == user.Id)
                || (grant.SubjectType == "Department" && grant.SubjectId == user.DepartmentId
                    && db.Departments.Any(dept => dept.Id == user.DepartmentId && dept.IsEnabled))
                || (grant.SubjectType == "Role" && db.UserRoles.Any(role => role.UserId == user.Id && role.RoleId == grant.SubjectId)))), ct);
    }

    public async Task<AccessGrantSelection> GetAsync(string resourceKey, CancellationToken ct)
    {
        var grants = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey == resourceKey).ToArrayAsync(ct);
        return new(grants.Where(x => x.SubjectType == "User").Select(x => x.SubjectId).ToArray(),
            grants.Where(x => x.SubjectType == "Role").Select(x => x.SubjectId).ToArray(),
            grants.Where(x => x.SubjectType == "Department").Select(x => x.SubjectId).ToArray());
    }

    public async Task SetAsync(string resourceKey, AccessGrantSelection input, CancellationToken ct)
    {
        var users = input.UserIds.Distinct().ToArray();
        var roles = input.RoleIds.Distinct().ToArray();
        var departments = input.DepartmentIds.Distinct().ToArray();
        if (await db.Users.CountAsync(x => users.Contains(x.Id) && x.IsEnabled, ct) != users.Length)
            throw new WorkflowException("包含不存在或已停用的用户", 400);
        if (await db.Roles.CountAsync(x => roles.Contains(x.Id), ct) != roles.Length)
            throw new WorkflowException("包含不存在的角色", 400);
        if (await db.Departments.CountAsync(x => departments.Contains(x.Id) && x.IsEnabled, ct) != departments.Length)
            throw new WorkflowException("包含不存在或已停用的部门", 400);
        var desired = users.Select(id => (Type: "User", Id: id))
            .Concat(roles.Select(id => (Type: "Role", Id: id)))
            .Concat(departments.Select(id => (Type: "Department", Id: id))).ToHashSet();
        var existing = await db.AccessGrants.Where(x => x.ResourceKey == resourceKey).ToArrayAsync(ct);
        db.AccessGrants.RemoveRange(existing.Where(x => !desired.Contains((x.SubjectType, x.SubjectId))));
        db.AccessGrants.AddRange(desired.Except(existing.Select(x => (x.SubjectType, x.SubjectId)))
            .Select(x => new AccessGrant { ResourceKey = resourceKey, SubjectType = x.Item1, SubjectId = x.Item2 }));
        await db.SaveChangesAsync(ct);
    }
}
