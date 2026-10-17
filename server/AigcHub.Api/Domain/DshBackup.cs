namespace AigcHub.Api.Domain;

public sealed class DshBackup
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public string Payload { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Bytes { get; set; }
    public int SessionCount { get; set; }
    public string Scope { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
