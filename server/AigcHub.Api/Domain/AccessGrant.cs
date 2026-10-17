namespace AigcHub.Api.Domain;

public sealed class AccessGrant
{
    public required string ResourceKey { get; set; }
    public required string SubjectType { get; set; }
    public Guid SubjectId { get; set; }
}

public sealed class WebSearchConfiguration
{
    public int Id { get; set; } = 1;
    public string ApiKeyProtected { get; set; } = "";
    public bool IsEnabled { get; set; }
}
