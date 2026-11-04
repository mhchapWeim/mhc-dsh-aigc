namespace AigcHub.Api.Domain;

public sealed class ConfigSyncRevision
{
    public int Id { get; set; } = 1;
    public long Revision { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ConfigSyncEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public long Revision { get; set; }
    public string Domains { get; set; } = "models,billing,access";
    public string Status { get; set; } = "Pending";
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset NextAttemptAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SentAt { get; set; }
    public string ErrorCode { get; set; } = "";
}

public sealed class ConfigSyncDevice
{
    public Guid UserId { get; set; }
    public Guid DeviceId { get; set; }
    public string DeviceName { get; set; } = "";
    public string ClientVersion { get; set; } = "";
    public long AppliedRevision { get; set; } = -1;
    public long OfferedRevision { get; set; } = -1;
    public Guid OfferId { get; set; }
    public long AttemptedRevision { get; set; }
    public string Status { get; set; } = "Pending";
    public string ErrorCode { get; set; } = "";
    public DateTimeOffset LastSeenAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? AppliedAt { get; set; }
}
