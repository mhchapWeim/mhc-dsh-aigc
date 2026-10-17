namespace AigcHub.Api.Domain;

public sealed class DshFeedback
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public string SessionId { get; set; } = "";
    public string Category { get; set; } = "";
    public string Text { get; set; } = "";
    public string SessionLog { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}
