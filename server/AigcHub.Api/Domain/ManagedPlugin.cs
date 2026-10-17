namespace AigcHub.Api.Domain;

public sealed class ManagedPlugin
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string PackageName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public bool IsEnabled { get; set; }
    public Guid? PublishedVersionId { get; set; }
    public long Revision { get; set; } = 1;
    public string ConfigurationJson { get; set; } = "{}";
    public string ServerSecretProtected { get; set; } = "";
    public List<ManagedPluginVersion> Versions { get; set; } = [];
}

public sealed class ManagedPluginVersion
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PluginId { get; set; }
    public ManagedPlugin Plugin { get; set; } = null!;
    public string Version { get; set; } = "";
    public string DshVersion { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long Size { get; set; }
    public string ManifestJson { get; set; } = "{}";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ManagedPluginReport
{
    public Guid UserId { get; set; }
    public string DeviceId { get; set; } = "";
    public Guid PluginId { get; set; }
    public string Version { get; set; } = "";
    public long Revision { get; set; }
    public string Status { get; set; } = "";
    public string Error { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
