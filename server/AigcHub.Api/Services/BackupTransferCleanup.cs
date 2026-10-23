using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

/// <summary>Expire abandoned reservations as well as incomplete objects.</summary>
public sealed class BackupTransferCleanup(IServiceScopeFactory scopes, ILogger<BackupTransferCleanup> logger) : BackgroundService
{
    public static async Task CleanAsync(AigcHubDbContext db, IBackupObjectStore store, BackupStorageOptions options, CancellationToken ct)
    {
        if (!options.Enabled) return;
        await BackupTransferEndpoints.Mutation.WaitAsync(ct);
        try {
            var cutoff = DateTimeOffset.UtcNow.AddHours(-options.UploadLifetimeHours);
            var rows = await db.DshBackups.Where(x => x.Scope.StartsWith("pending:") && x.CreatedAt < cutoff).ToListAsync(ct);
            foreach (var row in rows) {
                var metadata = BackupTransferEndpoints.Descriptor(row);
                if (metadata is null) continue;
                await store.DeleteAsync(metadata.Key, metadata.UploadId, ct);
                db.DshBackups.Remove(row);
                await db.SaveChangesAsync(ct);
            }
        } finally { BackupTransferEndpoints.Mutation.Release(); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested) {
            try {
                await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
                await using var scope = scopes.CreateAsyncScope();
                await CleanAsync(scope.ServiceProvider.GetRequiredService<AigcHubDbContext>(),
                    scope.ServiceProvider.GetRequiredService<IBackupObjectStore>(),
                    scope.ServiceProvider.GetRequiredService<IOptions<BackupStorageOptions>>().Value, stoppingToken);
            } catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception error) { logger.LogError(error, "Backup transfer expiration failed"); }
        }
    }
}
