using AigcHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace AigcHub.Api.Services;

public sealed record VirtualKeyGrantSelection(Guid[] UserIds, Guid[] DepartmentIds, Guid[] OrganizationIds, Guid[] RoleIds);
public sealed record VirtualKeyMembership(Guid KeyId, string KeyAlias, string Source);

/// <summary>Resolve effective membership before granting a Key, including inherited access.</summary>
public static class VirtualKeyGrantRules
{
    private static readonly SemaphoreSlim MutationLock = new(1, 1);

    public sealed class Mutation(IDbContextTransaction? transaction) : IAsyncDisposable
    {
        public Task CommitAsync(CancellationToken ct) => transaction?.CommitAsync(ct) ?? Task.CompletedTask;
        public async ValueTask DisposeAsync()
        {
            try { if (transaction is not null) await transaction.DisposeAsync(); }
            finally { MutationLock.Release(); }
        }
    }

    public static async Task<Mutation> BeginMutationAsync(AigcHubDbContext db, CancellationToken ct)
    {
        await MutationLock.WaitAsync(ct);
        IDbContextTransaction? transaction = null;
        try
        {
            if (db.Database.IsRelational())
            {
                transaction = await db.Database.BeginTransactionAsync(ct);
                // Serialize participating grant writes across API instances on production PostgreSQL.
                if (db.Database.ProviderName?.Contains("Npgsql", StringComparison.Ordinal) == true)
                    await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(736421009)", ct);
            }
            return new Mutation(transaction);
        }
        catch
        {
            if (transaction is not null) await transaction.DisposeAsync();
            MutationLock.Release();
            throw;
        }
    }

    public static async Task<Dictionary<Guid, VirtualKeyMembership[]>> MembershipsAsync(AigcHubDbContext db,
        CancellationToken ct, Guid? keyOverride = null, VirtualKeyGrantSelection? selection = null,
        Guid? organizationOverride = null, Guid[]? organizationUsers = null)
    {
        // Disabled keys still reserve their scope, so re-enabling cannot silently create overlap.
        var keys = await db.ManagedVirtualKeys.AsNoTracking().ToArrayAsync(ct);
        var users = await db.Users.AsNoTracking().Select(x => new { x.Id, x.DepartmentId }).ToArrayAsync(ct);
        var departments = await db.Departments.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        var roles = await db.Roles.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        var organizations = await db.VirtualKeyOrganizations.AsNoTracking().ToDictionaryAsync(x => x.Id, x => x.Name, ct);
        var userRoles = await db.UserRoles.AsNoTracking().ToArrayAsync(ct);
        var members = await db.VirtualKeyOrganizationMembers.AsNoTracking().ToArrayAsync(ct);
        var grants = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey.StartsWith("virtual-key:")).ToArrayAsync(ct);
        var result = new Dictionary<Guid, List<VirtualKeyMembership>>();
        foreach (var key in keys)
        {
            var subjects = keyOverride == key.Id && selection is not null
                ? selection.UserIds.Select(id => (Type: "User", Id: id))
                    .Concat(selection.DepartmentIds.Select(id => (Type: "Department", Id: id)))
                    .Concat(selection.RoleIds.Select(id => (Type: "Role", Id: id)))
                    .Concat(selection.OrganizationIds.Select(id => (Type: "Organization", Id: id)))
                : grants.Where(x => x.ResourceKey == $"virtual-key:{key.Id:D}").Select(x => (Type: x.SubjectType, Id: x.SubjectId));
            foreach (var subject in subjects)
            {
                var ids = subject.Type switch
                {
                    "User" => new[] { subject.Id },
                    "Department" => users.Where(x => x.DepartmentId == subject.Id).Select(x => x.Id),
                    "Role" => userRoles.Where(x => x.RoleId == subject.Id).Select(x => x.UserId),
                    "Organization" => organizationOverride == subject.Id && organizationUsers is not null
                        ? organizationUsers : members.Where(x => x.OrganizationId == subject.Id).Select(x => x.UserId),
                    _ => []
                };
                var source = subject.Type switch
                {
                    "User" => "直接授权",
                    "Department" => $"部门：{departments.GetValueOrDefault(subject.Id, "已删除部门")}",
                    "Role" => $"角色：{roles.GetValueOrDefault(subject.Id, "已删除角色")}",
                    "Organization" => $"分组：{organizations.GetValueOrDefault(subject.Id, "新分组")}",
                    _ => subject.Type
                };
                foreach (var id in ids)
                {
                    if (!result.TryGetValue(id, out var memberships)) result[id] = memberships = [];
                    memberships.Add(new(key.Id, key.Alias, source));
                }
            }
        }
        return result.ToDictionary(x => x.Key, x => x.Value.GroupBy(v => v.KeyId)
            .Select(g => new VirtualKeyMembership(g.Key, g.First().KeyAlias,
                string.Join("、", g.Select(v => v.Source).Distinct()))).ToArray());
    }

    public static async Task AssertExclusiveAsync(AigcHubDbContext db, Guid keyId, CancellationToken ct,
        VirtualKeyGrantSelection? selection = null, Guid? organizationId = null, Guid[]? organizationUsers = null)
    {
        var memberships = await MembershipsAsync(db, ct, selection is null ? null : keyId, selection, organizationId, organizationUsers);
        var conflicts = memberships.Where(x => x.Value.Any(v => v.KeyId == keyId) && x.Value.Length > 1).Take(5).ToArray();
        if (conflicts.Length == 0) return;
        var ids = conflicts.Select(x => x.Key).ToArray();
        var names = await db.Users.AsNoTracking().Where(x => ids.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => $"{x.Name}（{x.EmployeeNo}）", ct);
        var detail = string.Join("；", conflicts.Select(x => $"{names.GetValueOrDefault(x.Key, x.Key.ToString())}已在“{string.Join("、", x.Value.Where(v => v.KeyId != keyId).Select(v => v.KeyAlias))}”组"));
        throw new WorkflowException($"同一用户不能属于多个虚拟 Key 组：{detail}。请先移除原组授权", 409);
    }

    public static async Task<object> GrantOptionsAsync(AigcHubDbContext db, Guid? keyId, CancellationToken ct)
    {
        var memberships = await MembershipsAsync(db, ct);
        var users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo).ToArrayAsync(ct);
        var allUsers = await db.Users.AsNoTracking().Select(x => new { x.Id, x.DepartmentId }).ToArrayAsync(ct);
        var userRoles = await db.UserRoles.AsNoTracking().ToArrayAsync(ct);
        var departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name).ToArrayAsync(ct);
        var roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name).ToArrayAsync(ct);
        string? Reason(IEnumerable<Guid> ids)
        {
            if (keyId is null) return null;
            var occupied = ids.SelectMany(id => memberships.GetValueOrDefault(id, []))
                .Where(x => x.KeyId != keyId).Distinct().ToArray();
            return occupied.Length == 0 ? null : $"已在{string.Join("；", occupied.Select(x => $"“{x.KeyAlias}”组（{x.Source}）").Distinct())}";
        }
        return new
        {
            users = users.Select(x => new { x.Id, x.Name, x.EmployeeNo,
                disabled = Reason([x.Id]) is not null, disabledReason = Reason([x.Id]),
                keyMemberships = memberships.GetValueOrDefault(x.Id, []) }).ToArray(),
            departments = departments.Select(x => new { x.Id, x.Name, x.Code,
                disabled = Reason(allUsers.Where(u => u.DepartmentId == x.Id).Select(u => u.Id)) is not null,
                disabledReason = Reason(allUsers.Where(u => u.DepartmentId == x.Id).Select(u => u.Id)) }).ToArray(),
            roles = roles.Select(x => new { x.Id, x.Name, x.Code,
                disabled = Reason(userRoles.Where(u => u.RoleId == x.Id).Select(u => u.UserId)) is not null,
                disabledReason = Reason(userRoles.Where(u => u.RoleId == x.Id).Select(u => u.UserId)) }).ToArray()
        };
    }

    public static async Task AssertUserAssignmentAsync(AigcHubDbContext db, Guid userId, Guid? departmentId,
        Guid[] roleIds, CancellationToken ct)
    {
        var organizations = await db.VirtualKeyOrganizationMembers.AsNoTracking().Where(x => x.UserId == userId)
            .Select(x => x.OrganizationId).ToArrayAsync(ct);
        var grants = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey.StartsWith("virtual-key:")
            && ((x.SubjectType == "User" && x.SubjectId == userId)
                || (x.SubjectType == "Department" && x.SubjectId == departmentId)
                || (x.SubjectType == "Role" && roleIds.Contains(x.SubjectId))
                || (x.SubjectType == "Organization" && organizations.Contains(x.SubjectId))))
            .Select(x => x.ResourceKey).Distinct().ToArrayAsync(ct);
        var keys = await db.ManagedVirtualKeys.AsNoTracking().ToArrayAsync(ct);
        var aliases = keys.Where(x => grants.Contains($"virtual-key:{x.Id:D}")).Select(x => x.Alias).ToArray();
        if (aliases.Length > 1)
            throw new WorkflowException($"该部门和角色组合会使用户同时归属多个虚拟 Key 组：{string.Join("、", aliases)}。请先调整 Key 授权", 409);
    }
}
