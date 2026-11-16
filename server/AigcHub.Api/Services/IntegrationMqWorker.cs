using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using RabbitMQ.Client;

namespace AigcHub.Api.Services;

/// <summary>Database-backed outbox and bounded polling inbox. Broker topology is provisioned by operations.</summary>
public sealed class IntegrationMqWorker(IServiceScopeFactory scopes, IConfiguration config, ILogger<IntegrationMqWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
                var services = await db.IntegrationServices.AsNoTracking().Where(x => x.Kind == "Mq" && x.IsEnabled).ToListAsync(stoppingToken);
                foreach (var service in services)
                {
                    try { await ProcessAsync(service, stoppingToken); }
                    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
                    catch (Exception error)
                    {
                        log.LogWarning("Integration service {Service} cycle failed: {ErrorType}", service.Code, error.GetType().Name);
                        await RecordFailureAsync(service.Code, stoppingToken);
                    }
                }
                await ExpireAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception error) { log.LogWarning("Integration worker cycle failed: {ErrorType}", error.GetType().Name); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private async Task ProcessAsync(IntegrationService service, CancellationToken ct)
    {
        var settings = config.GetSection($"IntegrationConnections:{service.ConnectionKey}");
        if (!settings.GetValue<bool>("Enabled")) return;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var token = timeout.Token;
        var factory = new ConnectionFactory { HostName = settings["HostName"] ?? "localhost", Port = settings.GetValue("Port", 5672),
            VirtualHost = settings["VirtualHost"] ?? "/", UserName = settings["UserName"] ?? "", Password = settings["Password"] ?? "",
            AutomaticRecoveryEnabled = false, RequestedConnectionTimeout = TimeSpan.FromSeconds(10),
            Ssl = new SslOption { Enabled = settings.GetValue<bool>("UseTls"), ServerName = settings["TlsServerName"] ?? settings["HostName"] ?? "localhost" } };
        await using var connection = await factory.CreateConnectionAsync("aigc-workflow-" + service.Code, token);
        await using var channel = await connection.CreateChannelAsync(new CreateChannelOptions(publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true), token);
        using (var scope = scopes.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var ids = await db.IntegrationInvocations.Where(x => x.ServiceCode == service.Code && x.ConnectionKey == service.ConnectionKey && x.Status == "Pending" && x.NextAttemptAt <= DateTimeOffset.UtcNow && x.ExpiresAt > DateTimeOffset.UtcNow)
                .OrderBy(x => x.NextAttemptAt).Select(x => x.Id).Take(10).ToListAsync(token);
            foreach (var id in ids)
            {
                await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(token) : null;
                if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({id.ToString()}))", token);
                var call = await db.IntegrationInvocations.SingleAsync(x => x.Id == id, token);
                if (call.Status != "Pending") { if (tx is not null) await tx.CommitAsync(token); continue; }
                try
                {
                    var key = settings[$"RoutingKeys:{call.Operation}"] ?? call.Operation;
                    var properties = new BasicProperties { Persistent = true, ContentType = "application/json", ContentEncoding = "utf-8",
                        MessageId = call.Id.ToString(), CorrelationId = call.Id.ToString(), Type = call.Operation };
                    if (call.Protocol == CodeReviewProtocol.Name)
                    {
                        var body = JsonSerializer.Deserialize<ReviewRequest>(call.Payload, CodeReviewProtocol.JsonOptions)!;
                        if (Encoding.UTF8.GetByteCount(call.Payload) > CodeReviewProtocol.MaxBytes) throw new WorkflowException("审查请求超过 64 KiB");
                        properties.MessageId = body.MessageId; properties.CorrelationId = body.RequestId; properties.Type = body.EventType;
                        properties.Timestamp = new AmqpTimestamp(CodeReviewProtocol.Time(body.ProducedAt, "produced_at").ToUnixTimeSeconds());
                    }
                    await channel.BasicPublishAsync(settings["Exchange"] ?? "", key, true,
                        properties,
                        Encoding.UTF8.GetBytes(call.Payload), token);
                    call.Status = "Sent";
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    log.LogWarning("Integration publish failed Service={Service} Operation={Operation} Invocation={Invocation} ErrorType={ErrorType}", service.Code, call.Operation, call.Id, error.GetType().Name);
                    call.Attempts++;
                    call.Status = call.Attempts >= call.MaxAttempts ? "DeliveryFailed" : "Pending";
                    call.NextAttemptAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(300, Math.Pow(2, call.Attempts) * 5));
                }
                call.ConcurrencyToken = Guid.NewGuid();
                await db.SaveChangesAsync(ct);
                if (tx is not null) await tx.CommitAsync(ct);
            }
        }
        var queue = settings["ResultQueue"];
        if (string.IsNullOrWhiteSpace(queue)) return;
        for (var i = 0; i < 20; i++)
        {
            var message = await channel.BasicGetAsync(queue, false, token);
            if (message is null) break;
            try
            {
                if (message.Body.Length > 262144) throw new WorkflowException("结果消息过大");
                using var scope = scopes.CreateScope();
                var runner = scope.ServiceProvider.GetRequiredService<IntegrationWorkflowRunner>();
                var p = message.BasicProperties;
                await runner.ReceiveMessageAsync(service.Code, message.Body, new ReviewMessageProperties(p.MessageId, p.CorrelationId, p.Type,
                    p.ContentType, p.ContentEncoding, (byte)p.DeliveryMode, p.Timestamp.UnixTime), token);
                await channel.BasicAckAsync(message.DeliveryTag, false, token);
            }
            catch (Exception error) when (error is WorkflowException or JsonException)
            {
                log.LogWarning("Integration result rejected for {Service}: {ErrorType} ({ErrorDetail}); inspect configured dead-letter queue", service.Code, error.GetType().Name, error.Message);
                await channel.BasicRejectAsync(message.DeliveryTag, false, token);
            }
            // Transient DB/transport errors close the channel and requeue unacked deliveries.
        }
    }

    private async Task RecordFailureAsync(string code, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var ids = await db.IntegrationInvocations.Where(x => x.ServiceCode == code && x.Status == "Pending" && x.NextAttemptAt <= DateTimeOffset.UtcNow).Select(x => x.Id).Take(10).ToListAsync(ct);
        foreach (var id in ids)
        {
            await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
            if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({id.ToString()}))", ct);
            var call = await db.IntegrationInvocations.SingleAsync(x => x.Id == id, ct);
            if (call.Status != "Pending" || call.NextAttemptAt > DateTimeOffset.UtcNow) continue;
            call.Attempts++;
            call.Status = call.Attempts >= call.MaxAttempts ? "DeliveryFailed" : "Pending";
            call.NextAttemptAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(300, Math.Pow(2, call.Attempts) * 5));
            call.ConcurrencyToken = Guid.NewGuid();
            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
        }
    }

    private async Task ExpireAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var ids = await db.IntegrationInvocations.Where(x => (x.Status == "Pending" || x.Status == "Sent" || x.Status == "DeliveryFailed") && x.ExpiresAt <= DateTimeOffset.UtcNow)
            .Select(x => x.Id).Take(30).ToListAsync(ct);
        foreach (var id in ids)
        {
            using var itemScope = scopes.CreateScope();
            var context = itemScope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            await using var tx = context.Database.IsRelational() ? await context.Database.BeginTransactionAsync(ct) : null;
            if (context.Database.IsNpgsql()) await context.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({id.ToString()}))", ct);
            var call = await context.IntegrationInvocations.SingleAsync(x => x.Id == id, ct);
            if (call.Status is not ("Pending" or "Sent" or "DeliveryFailed")) continue;
            var instance = await context.WorkflowInstances.SingleAsync(x => x.Id == call.InstanceId, ct);
            if (instance.Status == WorkflowInstanceStatus.WaitingCallback && instance.CurrentNodeKey == call.NodeKey)
            {
                var request = await context.PublicationRequests.SingleAsync(x => x.Id == instance.BusinessId, ct);
                var definition = await context.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId, ct);
                await itemScope.ServiceProvider.GetRequiredService<IntegrationWorkflowRunner>().AdvanceAsync(definition, instance, request, call.NodeKey, "timeout", ct);
                context.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = call.NodeKey, EventType = "ServiceTimeout", Detail = id.ToString() });
            }
            call.Status = "TimedOut"; call.ConcurrencyToken = Guid.NewGuid();
            await context.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
        }
    }
}
