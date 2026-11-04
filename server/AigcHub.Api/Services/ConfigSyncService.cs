using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record ConfigSyncReport(Guid DeviceId, string DeviceName, string ClientVersion, long Revision,
    Guid OfferId, string Status, string ErrorCode = "");

public sealed class ConfigSyncService(AigcHubDbContext db, ModelConfigurationService models, TokenBillingService billing)
{
    // The PostgreSQL transaction lock also serializes device reports from different API replicas.
    private static readonly SemaphoreSlim Gate = new(1, 1);
    public Task<long> RevisionAsync(CancellationToken ct) => db.ConfigSyncRevisions.AsNoTracking()
        .Where(x => x.Id == 1).Select(x => x.Revision).SingleOrDefaultAsync(ct);

    public async Task<object> SnapshotAsync(AppUser user, Guid deviceId, CancellationToken ct)
    {
        if (deviceId == Guid.Empty) throw new WorkflowException("无效设备编号");
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var revision = await RevisionAsync(ct);
            var allowCustomModels = await db.Users.AsNoTracking().Where(x => x.Id == user.Id && x.IsEnabled).Select(x => (bool?)x.AllowCustomModels).SingleOrDefaultAsync(ct)
                ?? throw new WorkflowException("账号不可用", 403);
            var catalog = await models.AvailableAsync(user.Id, ct);
            var quota = await billing.QuotaAsync(user.Id, ct);
            if (revision != await RevisionAsync(ct)) continue;
            var offer = Guid.NewGuid();
            await DeviceMutationAsync(async () =>
            {
                var device = await DeviceAsync(user.Id, deviceId, ct);
                device.OfferedRevision = revision; device.OfferId = offer; device.LastSeenAt = DateTimeOffset.UtcNow;
                await db.SaveChangesAsync(ct);
            }, ct);
            return new { schemaVersion = 1, userId = user.Id, revision, offerId = offer,
                domains = new[] { "models", "billing", "access" }, capabilities = new { allowCustomModels }, models = catalog, billing = quota };
        }
        throw new WorkflowException("配置正在连续更新，请稍后重试", 409);
    }

    public async Task ReportAsync(Guid userId, ConfigSyncReport input, CancellationToken ct)
    {
        if (input.DeviceId == Guid.Empty || input.DeviceName is null || input.DeviceName.Length > 120 ||
            input.ClientVersion is null || input.ClientVersion.Length > 80 ||
            input.Status is not ("Applied" or "Failed" or "Heartbeat") || input.ErrorCode is null || input.ErrorCode.Length > 64 ||
            input.ErrorCode.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('_' or '-')))
            throw new WorkflowException("无效的配置同步回执");
        await DeviceMutationAsync(async () =>
        {
            var device = await DeviceAsync(userId, input.DeviceId, ct);
            if (input.Status != "Heartbeat")
            {
                var target = await RevisionAsync(ct);
                if (input.Revision < 0 || input.Revision > target || (input.Status == "Applied" || input.OfferId != Guid.Empty) &&
                    (device.OfferId != input.OfferId || device.OfferedRevision != input.Revision))
                    throw new WorkflowException("回执与已下发快照不匹配，请重新获取配置", 409);
                if (input.Revision >= device.AppliedRevision && input.Revision >= device.AttemptedRevision)
                {
                    device.AttemptedRevision = input.Revision;
                    // An error retry must not downgrade an already applied revision.
                    if (input.Status == "Applied")
                    { device.AppliedRevision = input.Revision; device.AppliedAt = DateTimeOffset.UtcNow; device.Status = "Applied"; device.ErrorCode = ""; }
                    else if (input.Revision > device.AppliedRevision)
                    { device.Status = "Failed"; device.ErrorCode = input.ErrorCode; }
                }
            }
            device.DeviceName = input.DeviceName.Trim(); device.ClientVersion = input.ClientVersion.Trim(); device.LastSeenAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
        }, ct);
    }

    private async Task<ConfigSyncDevice> DeviceAsync(Guid userId, Guid deviceId, CancellationToken ct)
    {
        var device = await db.ConfigSyncDevices.SingleOrDefaultAsync(x => x.UserId == userId && x.DeviceId == deviceId, ct);
        if (device is not null) return device;
        device = new ConfigSyncDevice { UserId = userId, DeviceId = deviceId };
        db.ConfigSyncDevices.Add(device); return device;
    }

    private async Task DeviceMutationAsync(Func<Task> action, CancellationToken ct)
    {
        await Gate.WaitAsync(ct);
        Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction? transaction = null;
        try
        {
            transaction = db.Database.IsRelational() && db.Database.CurrentTransaction is null ? await db.Database.BeginTransactionAsync(ct) : null;
            if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(72419308)", ct);
            await action();
            if (transaction is not null) await transaction.CommitAsync(ct);
        }
        finally { try { if (transaction is not null) await transaction.DisposeAsync(); } finally { Gate.Release(); } }
    }
}
