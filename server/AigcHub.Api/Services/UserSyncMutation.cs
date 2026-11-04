using AigcHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace AigcHub.Api.Services;

/// <summary>Serialize batch creation, manual retries and dispatch across threads and PostgreSQL replicas.</summary>
public static class UserSyncMutation
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    public static async Task<T> RunAsync<T>(AigcHubDbContext db, Func<Task<T>> action, CancellationToken ct)
    {
        await Gate.WaitAsync(ct);
        IDbContextTransaction? transaction = null;
        try
        {
            if (db.Database.IsRelational())
            {
                transaction = await db.Database.BeginTransactionAsync(ct);
                await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(736421020)", ct);
            }
            var result = await action();
            await db.SaveChangesAsync(ct);
            if (transaction is not null) await transaction.CommitAsync(ct);
            return result;
        }
        finally
        {
            if (transaction is not null) await transaction.DisposeAsync();
            Gate.Release();
        }
    }
}
