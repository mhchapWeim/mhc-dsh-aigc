namespace AigcHub.Api.Domain;

public sealed class SensitiveWord
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Term { get; set; }
    public required string NormalizedTerm { get; set; }
    public bool IsEnabled { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
