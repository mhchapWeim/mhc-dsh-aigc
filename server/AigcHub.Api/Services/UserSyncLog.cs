namespace AigcHub.Api.Services;

/// <summary>Stable event ids and safe reason codes for container log filtering.</summary>
public static class UserSyncLog
{
    public const string AdministrationCategory = "AigcHub.Api.Services.UserSyncAdministration";
    public static readonly EventId WorkerStarted = new(6200, "MqUserSyncWorkerStarted");
    public static readonly EventId Disabled = new(6201, "MqUserSyncDisabled");
    public static readonly EventId WorkerStopped = new(6202, "MqUserSyncWorkerStopped");
    public static readonly EventId Connecting = new(6210, "MqUserSyncConnecting");
    public static readonly EventId Connected = new(6211, "MqUserSyncConnected");
    public static readonly EventId ConnectionFailed = new(6212, "MqUserSyncConnectionFailed");
    public static readonly EventId ProducerStopped = new(6213, "MqUserSyncProducerStopped");
    public static readonly EventId Sent = new(6220, "MqUserSyncSent");
    public static readonly EventId RetryScheduled = new(6221, "MqUserSyncRetryScheduled");
    public static readonly EventId RetryExhausted = new(6222, "MqUserSyncRetryExhausted");
    public static readonly EventId CycleFailed = new(6223, "MqUserSyncCycleFailed");
    public static readonly EventId SnapshotQueued = new(6230, "MqUserSyncSnapshotQueued");
    public static readonly EventId ManualRetry = new(6231, "MqUserSyncManualRetry");

    // Never use exception.Message/ToString(): AMQP errors may embed connection credentials or payload data.
    public static string FailureCode(Exception error) => error switch
    {
        RabbitMQ.Client.Exceptions.PublishReturnException => "unroutable",
        RabbitMQ.Client.Exceptions.PublishException => "broker-nack",
        RabbitMQ.Client.Exceptions.AuthenticationFailureException => "authentication-failed",
        RabbitMQ.Client.Exceptions.BrokerUnreachableException => "broker-unreachable",
        OperationCanceledException or TimeoutException => "timeout",
        System.Security.Authentication.AuthenticationException => "tls-failed",
        IOException => "transport-failed",
        _ => "operation-failed"
    };
}
