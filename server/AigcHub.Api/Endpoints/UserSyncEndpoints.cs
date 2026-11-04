using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class UserSyncEndpoints
{
    public sealed record SnapshotInput(Guid RequestId);

    public static void MapUserSyncEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/users/sync").WithTags("用户同步").RequireAuthorization("user.manage");
        group.MapGet("/connection", (IOptions<UserSyncOptions> configured) =>
        {
            var options = configured.Value;
            return Results.Ok(new { options.Enabled, host = options.HostName, options.Port, options.VirtualHost,
                options.UseTls, options.Exchange, exchangeType = "topic", bindingKey = "aigc.user.*.v1",
                options.MaximumAttempts, consumers = options.Consumers.Select(x => new { x.ServiceName, x.Queue, x.UserName }),
                schemaVersion = 1, documentationPath = "docs/USER-SYNC-RABBITMQ.md" });
        });
        group.MapGet("/summary", async (AigcHubDbContext db, IOptions<UserSyncOptions> configured, CancellationToken ct) =>
        {
            var groups = await db.UserSyncMessages.AsNoTracking().GroupBy(x => x.Status)
                .Select(g => new { status = g.Key, count = g.Count() }).ToArrayAsync(ct);
            var latest = await db.UserSyncMessages.AsNoTracking().Where(x => x.SentAt != null)
                .OrderByDescending(x => x.SentAt).Select(x => x.SentAt).FirstOrDefaultAsync(ct);
            return Results.Ok(new { configured.Value.Enabled, pending = groups.SingleOrDefault(x => x.status == "Pending")?.count ?? 0,
                sent = groups.SingleOrDefault(x => x.status == "Sent")?.count ?? 0,
                failed = groups.SingleOrDefault(x => x.status == "Failed")?.count ?? 0, lastSentAt = latest });
        });
        group.MapGet("/messages", async (int? page, int? pageSize, string? keyword, string? status, Guid? userId, Guid? batchId, AigcHubDbContext db, CancellationToken ct) =>
        {
            var (number, size) = EndpointHelpers.NormalizePage(page ?? 1, pageSize ?? 10);
            if (!string.IsNullOrEmpty(status) && status is not ("Pending" or "Sent" or "Failed")) return Results.BadRequest(new { message = "发送状态无效" });
            var query = db.UserSyncMessages.AsNoTracking();
            if (!string.IsNullOrWhiteSpace(keyword)) query = query.Where(x => x.UserName.Contains(keyword) || x.EmployeeNo.Contains(keyword));
            if (!string.IsNullOrEmpty(status)) query = query.Where(x => x.Status == status);
            if (userId.HasValue) query = query.Where(x => x.UserId == userId);
            if (batchId.HasValue) query = query.Where(x => x.BatchId == batchId);
            var total = await query.CountAsync(ct);
            var items = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Skip((number - 1) * size).Take(size)
                .Select(x => new { x.Id, x.UserId, x.UserName, x.EmployeeNo, x.UserVersion, x.BatchId, x.EventType,
                    x.Status, x.Attempts, x.ConsecutiveFailures, x.CreatedAt, x.SentAt, x.NextAttemptAt, x.LastError }).ToArrayAsync(ct);
            return Results.Ok(new { items, total, page = number, pageSize = size });
        });
        group.MapGet("/batches", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(
            await db.UserSyncBatches.AsNoTracking().OrderByDescending(x => x.CreatedAt).Take(10).Select(x => new
            {
                x.Id, x.CreatedAt, x.Total,
                sent = db.UserSyncMessages.Count(m => m.BatchId == x.Id && m.Status == "Sent"),
                failed = db.UserSyncMessages.Count(m => m.BatchId == x.Id && m.Status == "Failed")
            }).ToArrayAsync(ct)));
        group.MapPost("/snapshot", async (SnapshotInput input, ICurrentUser current, AigcHubDbContext db, ILoggerFactory logs, CancellationToken ct) =>
        {
            if (input.RequestId == Guid.Empty) return Results.BadRequest(new { message = "请提供有效的请求编号" });
            var created = false;
            var batch = await UserSyncMutation.RunAsync(db, async () =>
            {
                var existing = await db.UserSyncBatches.SingleOrDefaultAsync(x => x.Id == input.RequestId, ct);
                if (existing is not null) return existing;
                // One joined SELECT reads a coherent user/version/department snapshot; newer deltas may arrive first.
                var users = await db.Users.AsNoTracking().Include(x => x.Department).ToArrayAsync(ct);
                created = true;
                var result = new UserSyncBatch { Id = input.RequestId, CreatedBy = current.Id, Total = users.Length };
                db.UserSyncBatches.Add(result);
                db.UserSyncMessages.AddRange(users.Select(x => AigcHubDbContext.CreateUserSyncMessage(x, x.Department, "user.snapshot", result.Id)));
                db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "user-sync.snapshot", EntityType = "UserSyncBatch", EntityId = result.Id.ToString(), Succeeded = true });
                return result;
            }, ct);
            if (created) logs.CreateLogger(UserSyncLog.AdministrationCategory).LogInformation(UserSyncLog.SnapshotQueued,
                "MQ.UserSync.SnapshotQueued BatchId={BatchId} Count={Count} ActorId={ActorId}", batch.Id, batch.Total, current.Id);
            return Results.Accepted($"/api/users/sync/messages?batchId={batch.Id}", new { batch.Id, batch.Total });
        });
        group.MapPost("/messages/{id:guid}/retry", async (Guid id, ICurrentUser current, AigcHubDbContext db, ILoggerFactory logs, CancellationToken ct) =>
        {
            var result = await UserSyncMutation.RunAsync<IResult>(db, async () =>
            {
                var message = await db.UserSyncMessages.SingleOrDefaultAsync(x => x.Id == id, ct);
                if (message is null) return Results.NotFound();
                if (message.Status != "Failed") return Results.Conflict(new { message = "仅发送失败的消息可以重试" });
                message.Status = "Pending"; message.ConsecutiveFailures = 0; message.NextAttemptAt = DateTimeOffset.UtcNow;
                db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "user-sync.retry", EntityType = "UserSyncMessage", EntityId = id.ToString(), Succeeded = true });
                return Results.NoContent();
            }, ct);
            if (result is IStatusCodeHttpResult { StatusCode: StatusCodes.Status204NoContent })
                logs.CreateLogger(UserSyncLog.AdministrationCategory).LogInformation(UserSyncLog.ManualRetry,
                    "MQ.UserSync.ManualRetry EventId={EventId} ActorId={ActorId}", id, current.Id);
            return result;
        });
    }
}
