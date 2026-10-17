namespace AigcHub.Api.Domain;

public sealed class DshFailure
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid? UserId { get; set; }
    public AppUser? User { get; set; }
    public Guid EventId { get; set; }
    public string DeviceId { get; set; } = "";
    public string AppVersion { get; set; } = "";
    public string Category { get; set; } = "";
    public string Operation { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string OperationId { get; set; } = "";
    public DateTimeOffset OccurredAt { get; set; }
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
    public string PayloadJson { get; set; } = "";
}
