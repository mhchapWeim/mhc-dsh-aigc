using System.Text.Json;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Data;

public sealed partial class AigcHubDbContext
{
    public DbSet<UserSyncMessage> UserSyncMessages => Set<UserSyncMessage>();
    public DbSet<UserSyncBatch> UserSyncBatches => Set<UserSyncBatch>();

    public override int SaveChanges(bool acceptAllChangesOnSuccess) =>
        SaveChangesAsync(acceptAllChangesOnSuccess).GetAwaiter().GetResult();

    public override async Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        await CaptureUserChangesAsync(cancellationToken);
        if (!HasConfigurationChanges()) return await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
        var owned = Database.IsRelational() && Database.CurrentTransaction is null
            ? await Database.BeginTransactionAsync(cancellationToken) : null;
        try
        {
            if (Database.IsNpgsql())
                await Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(72419306)", cancellationToken);
            await CaptureConfigChangesAsync(cancellationToken);
            var result = await base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
            if (owned is not null) await owned.CommitAsync(cancellationToken);
            return result;
        }
        finally { if (owned is not null) await owned.DisposeAsync(); }
    }

    private async Task CaptureUserChangesAsync(CancellationToken ct)
    {
        ChangeTracker.DetectChanges();
        var changedDepartments = ChangeTracker.Entries<Department>()
            .Where(e => e.State == EntityState.Deleted || e.State == EntityState.Modified &&
                new[] { "Code", "Name", "IsEnabled" }.Any(p => e.Property(p).IsModified))
            .Select(e => e.Entity.Id).ToArray();
        // Load affected members into this unit of work so their version and department event commit together.
        if (changedDepartments.Length > 0)
            await Users.Where(x => x.DepartmentId != null && changedDepartments.Contains(x.DepartmentId.Value)).LoadAsync(ct);
        var entries = ChangeTracker.Entries<AppUser>().Where(e =>
            e.State is EntityState.Added or EntityState.Deleted || e.State == EntityState.Modified &&
                new[] { "EmployeeNo", "Name", "Email", "DepartmentId", "IsEnabled", "DeletedAt" }.Any(p => e.Property(p).IsModified)
            || e.Entity.DepartmentId.HasValue && changedDepartments.Contains(e.Entity.DepartmentId.Value)).ToArray();
        if (entries.Length == 0) return;
        var departmentIds = entries.Where(x => x.Entity.DepartmentId != null).Select(x => x.Entity.DepartmentId!.Value).Distinct().ToArray();
        var departments = await Departments.Where(x => departmentIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, ct);
        foreach (var department in ChangeTracker.Entries<Department>())
        {
            if (department.State == EntityState.Deleted) departments.Remove(department.Entity.Id);
            else departments[department.Entity.Id] = department.Entity;
        }
        foreach (var entry in entries)
        {
            var user = entry.Entity;
            // A failed SaveChanges can be retried using the same context without adding another event.
            if (UserSyncMessages.Local.Any(x => Entry(x).State == EntityState.Added && x.BatchId == null
                && x.UserId == user.Id && x.UserVersion == user.SyncVersion)) continue;
            user.SyncVersion = checked(user.SyncVersion + 1);
            UserSyncMessages.Add(CreateUserSyncMessage(user,
                user.DepartmentId.HasValue ? departments.GetValueOrDefault(user.DepartmentId.Value) : null,
                entry.State == EntityState.Deleted || user.DeletedAt != null ? "user.deleted" : "user.upsert"));
        }
    }

    public static UserSyncMessage CreateUserSyncMessage(AppUser user, Department? department, string eventType, Guid? batchId = null)
    {
        var message = new UserSyncMessage { UserId = user.Id, UserName = user.Name, EmployeeNo = user.EmployeeNo,
            UserVersion = user.SyncVersion, EventType = eventType, BatchId = batchId };
        message.Payload = JsonSerializer.Serialize(new
        {
            schemaVersion = 1, eventId = message.Id, eventType, source = "aigc", occurredAt = message.CreatedAt,
            batchId, userVersion = user.SyncVersion,
            user = new { id = user.Id, employeeNo = user.EmployeeNo, name = user.Name, email = user.Email,
                departmentId = user.DepartmentId,
                department = department is null ? null : new { id = department.Id, code = department.Code, name = department.Name, isEnabled = department.IsEnabled },
                isEnabled = eventType != "user.deleted" && user.IsEnabled, isDeleted = eventType == "user.deleted" }
        });
        return message;
    }
}
