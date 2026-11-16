namespace AigcHub.Api.Domain;

public sealed class IntegrationService
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Kind { get; set; } = "Mq";
    public bool IsEnabled { get; set; }
    // Named server configuration, never credentials in workflow definitions.
    public string ConnectionKey { get; set; } = "";
    public string OperationsJson { get; set; } = "[]";
}

public sealed class IntegrationInvocation
{
    public string Protocol { get; set; } = "generic-v1";
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid InstanceId { get; set; }
    public string NodeKey { get; set; } = "";
    public string ServiceCode { get; set; } = "";
    public string ConnectionKey { get; set; } = "";
    public string Operation { get; set; } = "";
    public string ResultEvent { get; set; } = "";
    public string Status { get; set; } = "Pending";
    public string Payload { get; set; } = "{}";
    public string ResultJson { get; set; } = "{}";
    public int Attempts { get; set; }
    public int MaxAttempts { get; set; } = 5;
    public DateTimeOffset NextAttemptAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }
    public Guid ConcurrencyToken { get; set; } = Guid.NewGuid();
}

public sealed class IntegrationReceipt
{
    public string PayloadJson { get; set; } = "{}";
    public Guid Id { get; set; } = Guid.NewGuid();
    public string ServiceCode { get; set; } = "";
    public string MessageId { get; set; } = "";
    public Guid InvocationId { get; set; }
    public string Disposition { get; set; } = "";
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class GiteaConnection
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string ServiceCode { get; set; } = "";
    public long ExternalUserId { get; set; }
    public string Login { get; set; } = "";
    public string TokenProtected { get; set; } = "";
}

public sealed class GiteaAuthorization
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string ServiceCode { get; set; } = "";
    public string VerifierProtected { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public bool Consumed { get; set; }
}
