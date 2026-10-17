using AigcHub.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed class DshFailureCleanup(IServiceScopeFactory scopes, ILogger<DshFailureCleanup> logger) : BackgroundService
{
    // Keep the same seven UTC calendar days as the client journal.
    public static DateTimeOffset Cutoff => new(DateTime.UtcNow.Date.AddDays(-6), TimeSpan.Zero);

    public static async Task DeleteExpiredAsync(AigcHubDbContext db, CancellationToken ct)
    {
        var rows = db.DshFailures.Where(x => x.OccurredAt < Cutoff);
        if (db.Database.IsRelational()) await rows.ExecuteDeleteAsync(ct);
        else { db.RemoveRange(await rows.ToArrayAsync(ct)); await db.SaveChangesAsync(ct); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Program initializes additive tables before serving requests.
        try { await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken); }
        catch (OperationCanceledException) { return; }
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await DeleteExpiredAsync(scope.ServiceProvider.GetRequiredService<AigcHubDbContext>(), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception error) { logger.LogError(error, "DSH failure retention cleanup failed"); }
            try { await Task.Delay(TimeSpan.FromHours(1), stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }
}
