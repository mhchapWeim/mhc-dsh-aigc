namespace AigcHub.Api.Domain;

public sealed class DshUpload
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public required string ClientUploadId { get; set; }
    public required string SessionId { get; set; }
    public long EventSeq { get; set; }
    public required string Prompt { get; set; }
    public required string DeviceId { get; set; }
    public required string ComputerName { get; set; }
    public required string StoredPath { get; set; }
    public required string FileName { get; set; }
    public required string Sha256 { get; set; }
    public long Bytes { get; set; }
    public long Offset { get; set; }
    public bool Completed { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
}
