namespace AigcHub.Api.Domain;

public sealed class UserSyncMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string UserName { get; set; } = "";
    public string EmployeeNo { get; set; } = "";
    public long UserVersion { get; set; }
    public Guid? BatchId { get; set; }
    public string EventType { get; set; } = "user.upsert";
    public string Payload { get; set; } = "";
    public string Status { get; set; } = "Pending";
    public int Attempts { get; set; }
    public int ConsecutiveFailures { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset NextAttemptAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? SentAt { get; set; }
    public string LastError { get; set; } = "";
}

public sealed class UserSyncBatch
{
    public Guid Id { get; set; }
    public Guid CreatedBy { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public int Total { get; set; }
}
