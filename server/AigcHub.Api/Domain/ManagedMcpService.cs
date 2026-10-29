namespace AigcHub.Api.Domain;

/// <summary>An independently authorized remote MCP service. Credentials never enter client policy.</summary>
public sealed class ManagedMcpService
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public string Url { get; set; } = "";
    public bool IsEnabled { get; set; }
    public long Revision { get; set; } = 1;
    public int TimeoutSeconds { get; set; } = 60;
    public string SecretProtected { get; set; } = "";
    public string IconDataUrl { get; set; } = "";
    public McpAuthenticationMode AuthenticationMode { get; set; } = McpAuthenticationMode.GatewayBearer;
    public string TokenExchangeUrl { get; set; } = "";
    public string AssertionAudience { get; set; } = "";
    public string TokenResource { get; set; } = "";
    public string TokenScopes { get; set; } = "";
}

public enum McpAuthenticationMode
{
    GatewayBearer,
    UserAssertionExchange
}
