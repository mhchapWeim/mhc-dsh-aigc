namespace AigcHub.Api.Domain;

public sealed class UserModelGrant
{
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public Guid ModelId { get; set; }
    public AiModelConfiguration Model { get; set; } = null!;
}
