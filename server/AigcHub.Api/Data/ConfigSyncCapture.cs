using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Data;

public sealed partial class AigcHubDbContext
{
    public DbSet<ConfigSyncRevision> ConfigSyncRevisions => Set<ConfigSyncRevision>();
    public DbSet<ConfigSyncEvent> ConfigSyncEvents => Set<ConfigSyncEvent>();
    public DbSet<ConfigSyncDevice> ConfigSyncDevices => Set<ConfigSyncDevice>();

    private bool HasConfigurationChanges()
    {
        ChangeTracker.DetectChanges();
        return ChangeTracker.Entries().Any(e =>
        {
            if (e.State is not (EntityState.Added or EntityState.Modified or EntityState.Deleted)) return false;
            if (e.Entity is AppUser)
                return e.State != EntityState.Modified || e.Properties.Any(p => p.IsModified &&
                    p.Metadata.Name is "IsEnabled" or "DeletedAt" or "DepartmentId" or "AllowCustomModels");
            return e.Entity is AiModelConfiguration or UserModelGrant or AccessGrant or Department or Role or UserRole
                or RolePermission or ManagedVirtualKey or VirtualKeyOrganization or VirtualKeyOrganizationMember
                or TokenBillingPlan or TokenBillingAssignment or TokenIncrementPackage;
        });
    }

    private async Task CaptureConfigChangesAsync(CancellationToken ct)
    {
        // PostgreSQL callers hold the transaction advisory lock before loading this row.
        var state = await ConfigSyncRevisions.SingleOrDefaultAsync(x => x.Id == 1, ct);
        if (state is null) { state = new ConfigSyncRevision(); ConfigSyncRevisions.Add(state); }
        else if (Entry(state).State == EntityState.Unchanged) await Entry(state).ReloadAsync(ct);
        state.Revision = checked(state.Revision + 1);
        state.UpdatedAt = DateTimeOffset.UtcNow;
        ConfigSyncEvents.Add(new ConfigSyncEvent { Revision = state.Revision });
    }
}
