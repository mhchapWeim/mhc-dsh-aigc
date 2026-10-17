namespace AigcHub.Api.Domain;

public sealed class DshAccessToken
{
    public required string TokenHash { get; set; }
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public DateTimeOffset ExpiresAt { get; set; }
    public Guid? PersistentSessionId { get; set; }
}
