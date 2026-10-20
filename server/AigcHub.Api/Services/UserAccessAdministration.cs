using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

/// <summary>User administration changes direct grants only; inherited grants remain owned by their scope.</summary>
public static class UserAccessAdministration
{
    public static async Task<IResult> OptionsAsync(Guid? userId, AigcHubDbContext db, CancellationToken ct)
    {
        var user = userId.HasValue ? await db.Users.AsNoTracking().SingleOrDefaultAsync(x => x.Id == userId, ct) : null;
        var roles = await db.UserRoles.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.RoleId).ToArrayAsync(ct);
        var organizations = await db.VirtualKeyOrganizationMembers.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.OrganizationId).ToArrayAsync(ct);
        var grants = await db.AccessGrants.AsNoTracking().ToArrayAsync(ct);
        bool Inherited(AccessGrant x) => (x.SubjectType == "Department" && user?.DepartmentId != null && x.SubjectId == user.DepartmentId)
            || (x.SubjectType == "Role" && roles.Contains(x.SubjectId))
            || (x.SubjectType == "Organization" && organizations.Contains(x.SubjectId));
        var directModels = await db.UserModelGrants.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.ModelId).ToArrayAsync(ct);
        var models = await db.ModelConfigurations.AsNoTracking().OrderBy(x => x.Name).ToArrayAsync(ct);
        var keys = await db.ManagedVirtualKeys.AsNoTracking().OrderBy(x => x.Alias).ToArrayAsync(ct);
        return Results.Ok(new
        {
            departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name).Select(x => new { x.Id, x.Name }).ToArrayAsync(ct),
            roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name).Select(x => new { x.Id, x.Name }).ToArrayAsync(ct),
            models = models.Select(x => new { x.Id, x.Name, x.IsEnabled,
                departmentIds = grants.Where(g => g.ResourceKey == AccessGrantService.ModelKey(x.Id) && g.SubjectType == "Department").Select(g => g.SubjectId).ToArray(),
                roleIds = grants.Where(g => g.ResourceKey == AccessGrantService.ModelKey(x.Id) && g.SubjectType == "Role").Select(g => g.SubjectId).ToArray(),
                organizationInherited = false,
                selected = directModels.Contains(x.Id) || grants.Any(g => g.ResourceKey == AccessGrantService.ModelKey(x.Id) && g.SubjectType == "User" && g.SubjectId == userId),
                inherited = grants.Any(g => g.ResourceKey == AccessGrantService.ModelKey(x.Id) && Inherited(g)) }),
            virtualKeys = keys.Select(x => new { x.Id, name = x.Alias, x.IsEnabled,
                departmentIds = grants.Where(g => g.ResourceKey == $"virtual-key:{x.Id:D}" && g.SubjectType == "Department").Select(g => g.SubjectId).ToArray(),
                roleIds = grants.Where(g => g.ResourceKey == $"virtual-key:{x.Id:D}" && g.SubjectType == "Role").Select(g => g.SubjectId).ToArray(),
                organizationInherited = grants.Any(g => g.ResourceKey == $"virtual-key:{x.Id:D}" && g.SubjectType == "Organization" && organizations.Contains(g.SubjectId)),
                selected = grants.Any(g => g.ResourceKey == $"virtual-key:{x.Id:D}" && g.SubjectType == "User" && g.SubjectId == userId),
                inherited = grants.Any(g => g.ResourceKey == $"virtual-key:{x.Id:D}" && Inherited(g)) })
        });
    }

    // Caller holds the shared grant mutation lock and transaction, including user/role changes.
    public static async Task ApplyAsync(AigcHubDbContext db, Guid userId, SaveUserRequest input, CancellationToken ct)
    {
        if (await db.Roles.CountAsync(x => input.RoleIds.Contains(x.Id), ct) != input.RoleIds.Distinct().Count())
            throw new WorkflowException("包含不存在的角色", 400);
        var allGrants = await db.AccessGrants.Where(x => x.SubjectType == "User" && x.SubjectId == userId).ToArrayAsync(ct);
        var directKeys = allGrants.Where(x => x.ResourceKey.StartsWith("virtual-key:")).ToArray();
        var selectedKeys = input.VirtualKeyIds?.Distinct().ToArray();
        if (selectedKeys?.Length > 1) throw new WorkflowException("用户只能选择一个虚拟 Key 组", 409);
        if (selectedKeys is not null && await db.ManagedVirtualKeys.CountAsync(x => selectedKeys.Contains(x.Id), ct) != selectedKeys.Length)
            throw new WorkflowException("虚拟 Key 组不存在", 400);
        var organizations = await db.VirtualKeyOrganizationMembers.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.OrganizationId).ToArrayAsync(ct);
        var inherited = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey.StartsWith("virtual-key:") &&
            ((x.SubjectType == "Department" && x.SubjectId == input.DepartmentId)
            || (x.SubjectType == "Role" && input.RoleIds.Contains(x.SubjectId))
            || (x.SubjectType == "Organization" && organizations.Contains(x.SubjectId))))
            .Select(x => x.ResourceKey).ToArrayAsync(ct);
        var desiredKeys = selectedKeys is null ? directKeys.Select(x => x.ResourceKey).ToArray()
            : selectedKeys.Select(x => $"virtual-key:{x:D}").ToArray();
        var effectiveKeys = inherited.Concat(desiredKeys).Distinct().ToArray();
        if (effectiveKeys.Length > 1)
        {
            var aliases = await db.ManagedVirtualKeys.AsNoTracking().ToArrayAsync(ct);
            throw new WorkflowException($"用户已通过部门、角色或分组归属虚拟 Key 组，不能加入多个组：{string.Join("、", aliases.Where(x => effectiveKeys.Contains($"virtual-key:{x.Id:D}")).Select(x => x.Alias))}", 409);
        }
        var modelIds = input.ModelIds?.Distinct().ToArray();
        if (modelIds is not null)
        {
            if (await db.ModelConfigurations.CountAsync(x => modelIds.Contains(x.Id), ct) != modelIds.Length)
                throw new WorkflowException("模型不存在", 400);
            var existing = await db.UserModelGrants.Where(x => x.UserId == userId).ToArrayAsync(ct);
            db.UserModelGrants.RemoveRange(existing.Where(x => !modelIds.Contains(x.ModelId)));
            db.UserModelGrants.AddRange(modelIds.Except(existing.Select(x => x.ModelId)).Select(id => new UserModelGrant { UserId = userId, ModelId = id }));
            // Consolidate the two historical direct-grant stores without touching role/department grants.
            db.AccessGrants.RemoveRange(allGrants.Where(x => x.ResourceKey.StartsWith("model:") && !modelIds.Any(id => x.ResourceKey == AccessGrantService.ModelKey(id))));
        }
        if (selectedKeys is not null)
        {
            db.AccessGrants.RemoveRange(directKeys.Where(x => !desiredKeys.Contains(x.ResourceKey)));
            db.AccessGrants.AddRange(desiredKeys.Except(directKeys.Select(x => x.ResourceKey)).Select(key => new AccessGrant { ResourceKey = key, SubjectType = "User", SubjectId = userId }));
        }
    }
}
