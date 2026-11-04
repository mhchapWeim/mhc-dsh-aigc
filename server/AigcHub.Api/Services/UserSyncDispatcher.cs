using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using RabbitMQ.Client.Exceptions;

namespace AigcHub.Api.Services;

public sealed class UserSyncDispatcher(AigcHubDbContext db, IUserSyncPublisher publisher, IOptions<UserSyncOptions> configured, ILogger<UserSyncDispatcher> logger)
{
    public async Task<bool> SendNextAsync(CancellationToken ct)
    {
        UserSyncMessage? attempted = null;
        string? failureCode = null;
        string? errorType = null;
        var processed = await UserSyncMutation.RunAsync(db, async () =>
        {
            var options = configured.Value;
            if (!options.Enabled) return false;
            var now = DateTimeOffset.UtcNow;
            var message = await db.UserSyncMessages.Where(x => x.Status == "Pending" ||
                x.Status == "Failed" && x.ConsecutiveFailures < options.MaximumAttempts && x.NextAttemptAt <= now)
                .OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).FirstOrDefaultAsync(ct);
            if (message is null) return false;
            attempted = message;
            message.Attempts++;
            try
            {
                await publisher.PublishAsync(message, ct);
                message.Status = "Sent"; message.SentAt = DateTimeOffset.UtcNow;
                message.LastError = ""; message.ConsecutiveFailures = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception error)
            {
                message.Status = "Failed"; message.ConsecutiveFailures++;
                failureCode = UserSyncLog.FailureCode(error); errorType = error.GetType().Name;
                message.LastError = error is PublishException ? "MQ 未确认消息或没有匹配队列，请检查绑定和队列状态。"
                    : "MQ 发送失败，请检查网络、账号权限、TLS 和 Exchange 配置。";
                message.NextAttemptAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(3600, 5 * Math.Pow(2, Math.Min(message.ConsecutiveFailures, 10))));
            }
            return true;
        }, ct);
        // Report delivery only after the outbox state has committed, not merely after broker confirmation.
        if (attempted is null) return processed;
        if (attempted.Status == "Sent")
            logger.LogInformation(UserSyncLog.Sent,
                "MQ.UserSync.Sent EventId={EventId} BatchId={BatchId} UserId={UserId} UserVersion={UserVersion} EventType={EventType} Attempt={Attempt} SentAt={SentAt}",
                attempted.Id, attempted.BatchId, attempted.UserId, attempted.UserVersion, attempted.EventType, attempted.Attempts, attempted.SentAt);
        else
        {
            var exhausted = attempted.ConsecutiveFailures >= configured.Value.MaximumAttempts;
            logger.LogWarning(exhausted ? UserSyncLog.RetryExhausted : UserSyncLog.RetryScheduled,
                "MQ.UserSync.SendFailed EventId={EventId} BatchId={BatchId} UserId={UserId} UserVersion={UserVersion} Attempt={Attempt} ConsecutiveFailures={ConsecutiveFailures} MaxAttempts={MaxAttempts} AutoRetry={AutoRetry} NextAttemptAt={NextAttemptAt} FailureCode={FailureCode} ErrorType={ErrorType}",
                attempted.Id, attempted.BatchId, attempted.UserId, attempted.UserVersion, attempted.Attempts, attempted.ConsecutiveFailures,
                configured.Value.MaximumAttempts, !exhausted, exhausted ? (DateTimeOffset?)null : attempted.NextAttemptAt, failureCode, errorType);
        }
        return processed;
    }
}

public sealed class UserSyncWorker(IServiceScopeFactory scopes, IOptions<UserSyncOptions> configured, ILogger<UserSyncWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var options = configured.Value;
        logger.LogInformation(UserSyncLog.WorkerStarted,
            "MQ.UserSync.WorkerStarted Enabled={Enabled} Host={Host} Port={Port} VirtualHost={VirtualHost} Exchange={Exchange} Tls={Tls} PollSeconds={PollSeconds} MaxAttempts={MaxAttempts}",
            options.Enabled, options.HostName, options.Port, options.VirtualHost, options.Exchange, options.UseTls, options.PollSeconds, options.MaximumAttempts);
        if (!options.Enabled) logger.LogInformation(UserSyncLog.Disabled, "MQ.UserSync.Disabled CaptureOnly=true; outbox messages remain in the database until sending is enabled");
        try
        {
            // Schema initialization completes before the first dispatch; no broker connection is opened when disabled.
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(configured.Value.PollSeconds), stoppingToken);
                    if (!configured.Value.Enabled) continue;
                    for (var i = 0; i < 100 && !stoppingToken.IsCancellationRequested; i++)
                    {
                        await using var scope = scopes.CreateAsyncScope();
                        if (!await scope.ServiceProvider.GetRequiredService<UserSyncDispatcher>().SendNextAsync(stoppingToken)) break;
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
                catch (Exception error)
                {
                    logger.LogError(UserSyncLog.CycleFailed,
                        "MQ.UserSync.CycleFailed ErrorType={ErrorType}; persisted outbox will be retried", error.GetType().Name);
                }
            }
        }
        finally { logger.LogInformation(UserSyncLog.WorkerStopped, "MQ.UserSync.WorkerStopped"); }
    }
}
