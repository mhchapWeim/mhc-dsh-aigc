using System.Text;
using AigcHub.Api.Domain;
using Microsoft.Extensions.Options;
using RabbitMQ.Client;

namespace AigcHub.Api.Services;

public interface IUserSyncPublisher
{
    Task PublishAsync(UserSyncMessage message, CancellationToken ct);
}

/// <summary>One long-lived confirmed AMQP channel. Topology is provisioned on nj304, not by the producer.</summary>
public sealed class RabbitUserSyncPublisher(IOptions<UserSyncOptions> configured, ILogger<RabbitUserSyncPublisher> logger) : IUserSyncPublisher, IAsyncDisposable
{
    private IConnection? connection;
    private IChannel? channel;
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task PublishAsync(UserSyncMessage message, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        var connecting = false;
        try
        {
            var options = configured.Value;
            if (!options.Enabled) throw new InvalidOperationException("用户同步发送尚未启用");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(20));
            var token = timeout.Token;
            if (connection?.IsOpen != true || channel?.IsOpen != true)
            {
                await ResetAsync();
                connecting = true;
                logger.LogInformation(UserSyncLog.Connecting,
                    "MQ.UserSync.Connecting Host={Host} Port={Port} VirtualHost={VirtualHost} Exchange={Exchange} Tls={Tls}",
                    options.HostName, options.Port, options.VirtualHost, options.Exchange, options.UseTls);
                var factory = new ConnectionFactory { HostName = options.HostName, Port = options.Port,
                    VirtualHost = options.VirtualHost, UserName = options.UserName, Password = options.Password,
                    AutomaticRecoveryEnabled = false, RequestedConnectionTimeout = TimeSpan.FromSeconds(10),
                    ContinuationTimeout = TimeSpan.FromSeconds(10), HandshakeContinuationTimeout = TimeSpan.FromSeconds(10),
                    Ssl = new SslOption { Enabled = options.UseTls,
                        ServerName = string.IsNullOrWhiteSpace(options.TlsServerName) ? options.HostName : options.TlsServerName } };
                connection = await factory.CreateConnectionAsync("aigc-user-sync-producer", token);
                channel = await connection.CreateChannelAsync(new CreateChannelOptions(
                    publisherConfirmationsEnabled: true, publisherConfirmationTrackingEnabled: true), token);
                connecting = false;
                logger.LogInformation(UserSyncLog.Connected,
                    "MQ.UserSync.Connected Host={Host} Port={Port} VirtualHost={VirtualHost} Exchange={Exchange} PublisherConfirms=true Mandatory=true",
                    options.HostName, options.Port, options.VirtualHost, options.Exchange);
            }
            var properties = new BasicProperties { Persistent = true, ContentType = "application/json", ContentEncoding = "utf-8",
                MessageId = message.Id.ToString(), Type = message.EventType, AppId = "aigc",
                Timestamp = new AmqpTimestamp(message.CreatedAt.ToUnixTimeSeconds()) };
            // Tracked confirms throw on nack and mandatory returns; only a successful await is recorded as sent.
            await channel.BasicPublishAsync(options.Exchange, $"aigc.{message.EventType}.v1", true,
                properties, Encoding.UTF8.GetBytes(message.Payload), token);
        }
        catch (Exception error)
        {
            if (connecting && !ct.IsCancellationRequested)
                logger.LogWarning(UserSyncLog.ConnectionFailed,
                    "MQ.UserSync.ConnectionFailed EventId={EventId} FailureCode={FailureCode} ErrorType={ErrorType}",
                    message.Id, UserSyncLog.FailureCode(error), error.GetType().Name);
            await ResetAsync();
            throw;
        }
        finally { gate.Release(); }
    }

    private async Task ResetAsync()
    {
        var oldChannel = channel; var oldConnection = connection;
        channel = null; connection = null;
        try { if (oldChannel is not null) await oldChannel.DisposeAsync(); }
        finally { if (oldConnection is not null) await oldConnection.DisposeAsync(); }
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync();
        try
        {
            await ResetAsync();
            logger.LogInformation(UserSyncLog.ProducerStopped, "MQ.UserSync.ProducerStopped");
        }
        finally { gate.Release(); gate.Dispose(); }
    }
}
