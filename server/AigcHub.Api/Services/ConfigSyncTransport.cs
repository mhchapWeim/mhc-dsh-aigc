using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Threading.Channels;
using AigcHub.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace AigcHub.Api.Services;

public sealed class ConfigSyncOptions
{
    public bool Enabled { get; set; }
    public string HostName { get; set; } = "aigc-mq";
    [Range(1, 65535)] public int Port { get; set; } = 5672;
    public string VirtualHost { get; set; } = "/aigc";
    public string Exchange { get; set; } = "aigc.config.events";
    public string QueuePrefix { get; set; } = "aigc.config.api.";
    public string UserName { get; set; } = "";
    public string Password { get; set; } = "";
    public bool UseTls { get; set; }
    public string TlsServerName { get; set; } = "";
}

/// <summary>Bounded invalidation signals, one mailbox per online HTTPS connection.</summary>
public sealed class ConfigSyncSignals
{
    public bool MqConnected { get; set; }
    public string MqErrorCode { get; set; } = "";
    private readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, Channel<bool>> listeners = new();
    public (Guid Id, ChannelReader<bool> Reader) Subscribe()
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropOldest });
        listeners[id] = channel;
        return (id, channel.Reader);
    }
    public void Remove(Guid id) { if (listeners.TryRemove(id, out var channel)) channel.Writer.TryComplete(); }
    public void Notify() { foreach (var channel in listeners.Values) channel.Writer.TryWrite(true); }
}

/// <summary>Each API replica consumes its own MQ queue; outbox publication is confirmed and retried.</summary>
public sealed class ConfigSyncWorker(IServiceScopeFactory scopes, IOptions<ConfigSyncOptions> configured,
    ConfigSyncSignals signals, ILogger<ConfigSyncWorker> logger) : BackgroundService
{
    private IConnection? connection;
    private IChannel? publisher;
    private IChannel? subscriber;
    private readonly string instance = Guid.NewGuid().ToString("N");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configured.Value.Enabled) { logger.LogInformation("ConfigSync.MqDisabled DatabaseReconciliation=true"); return; }
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await EnsureConnectionAsync(stoppingToken);
                    if (!await DispatchAsync(stoppingToken)) await Task.Delay(1000, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
                catch (Exception error)
                {
                    logger.LogWarning("ConfigSync.MqRetry Code={Code}", UserSyncLog.FailureCode(error));
                    signals.MqErrorCode = UserSyncLog.FailureCode(error);
                    await CloseAsync();
                    await Task.Delay(5000, stoppingToken);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally { await CloseAsync(); }
    }

    private async Task EnsureConnectionAsync(CancellationToken ct)
    {
        if (connection?.IsOpen == true && publisher?.IsOpen == true && subscriber?.IsOpen == true) return;
        await CloseAsync();
        var options = configured.Value;
        var factory = new ConnectionFactory { HostName = options.HostName, Port = options.Port, VirtualHost = options.VirtualHost,
            UserName = options.UserName, Password = options.Password, AutomaticRecoveryEnabled = false,
            RequestedConnectionTimeout = TimeSpan.FromSeconds(10),
            Ssl = new SslOption { Enabled = options.UseTls, ServerName = string.IsNullOrEmpty(options.TlsServerName) ? options.HostName : options.TlsServerName } };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(20));
        connection = await factory.CreateConnectionAsync($"aigc-config-{instance}", timeout.Token);
        publisher = await connection.CreateChannelAsync(new CreateChannelOptions(publisherConfirmationsEnabled: true,
            publisherConfirmationTrackingEnabled: true), timeout.Token);
        subscriber = await connection.CreateChannelAsync(cancellationToken: timeout.Token);
        // Exchange is provisioned by operations. Runtime rights cover only prefixed instance queues and bindings.
        var queue = await subscriber.QueueDeclareAsync(options.QueuePrefix + instance, durable: false, exclusive: true,
            autoDelete: true, arguments: new Dictionary<string, object?> { ["x-queue-type"] = "classic" }, cancellationToken: timeout.Token);
        await subscriber.QueueBindAsync(queue.QueueName, options.Exchange, "config.#", cancellationToken: timeout.Token);
        await subscriber.BasicQosAsync(0, 16, false, timeout.Token);
        var consumeChannel = subscriber;
        var consumer = new AsyncEventingBasicConsumer(consumeChannel);
        consumer.ReceivedAsync += async (_, message) =>
        {
            if (message.Body.Length <= 4096)
            {
                try
                {
                    using var body = JsonDocument.Parse(message.Body);
                    if (body.RootElement.ValueKind == JsonValueKind.Object && body.RootElement.TryGetProperty("schemaVersion", out var schema)
                        && schema.ValueKind == JsonValueKind.Number && schema.TryGetInt32(out var version) && version == 1)
                        signals.Notify();
                }
                catch (JsonException) { logger.LogWarning("ConfigSync.InvalidMqEvent"); }
            }
            await consumeChannel.BasicAckAsync(message.DeliveryTag, false, ct);
        };
        await subscriber.BasicConsumeAsync(queue.QueueName, false, consumer, timeout.Token);
        signals.Notify(); // Recover connections that stayed online during an MQ interruption.
        signals.MqConnected = true; signals.MqErrorCode = "";
        logger.LogInformation("ConfigSync.MqConnected Instance={Instance}", instance);
    }

    private async Task<bool> DispatchAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var transaction = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        try
        {
            if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(72419307)", ct);
            var now = DateTimeOffset.UtcNow;
            var message = await db.ConfigSyncEvents.Where(x => x.Status != "Sent" && x.NextAttemptAt <= now)
                .OrderBy(x => x.Revision).FirstOrDefaultAsync(ct);
            if (message is null) return false;
            message.Attempts++;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(10));
                await publisher!.BasicPublishAsync(configured.Value.Exchange, "config.changed.v1", true,
                    new BasicProperties { Persistent = true, MessageId = message.Id.ToString(), ContentType = "application/json" },
                    JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = 1, eventId = message.Id, revision = message.Revision,
                        domains = message.Domains.Split(','), occurredAt = message.CreatedAt }), timeout.Token);
                message.Status = "Sent"; message.SentAt = DateTimeOffset.UtcNow; message.ErrorCode = "";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception error)
            {
                message.Status = "Failed"; message.ErrorCode = UserSyncLog.FailureCode(error);
                message.NextAttemptAt = DateTimeOffset.UtcNow.AddSeconds(Math.Min(300, Math.Pow(2, Math.Min(8, message.Attempts))));
            }
            await db.SaveChangesAsync(ct);
            if (transaction is not null) await transaction.CommitAsync(ct);
            return true;
        }
        finally { if (transaction is not null) await transaction.DisposeAsync(); }
    }

    private async Task CloseAsync()
    {
        signals.MqConnected = false;
        var resources = new IAsyncDisposable?[] { publisher, subscriber, connection };
        publisher = null; subscriber = null; connection = null;
        foreach (var resource in resources)
            try { if (resource is not null) await resource.DisposeAsync(); }
            catch (Exception error) { logger.LogWarning("ConfigSync.CloseFailed Code={Code}", UserSyncLog.FailureCode(error)); }
    }
}
