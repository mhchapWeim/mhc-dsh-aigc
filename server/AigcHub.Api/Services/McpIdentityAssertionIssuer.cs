using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using AigcHub.Api.Contracts;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace AigcHub.Api.Services;

public sealed class McpIdentityAssertionOptions
{
    public string Issuer { get; set; } = "bhss-aigc";
    public string KeyId { get; set; } = "";
    public string PrivateKeyPem { get; set; } = "";
    public int LifetimeSeconds { get; set; } = 60;
}

/// <summary>Issues short-lived, audience-bound employee assertions for trusted MCP token exchanges.</summary>
public sealed class McpIdentityAssertionIssuer
{
    private readonly McpIdentityAssertionOptions options;
    private readonly Lazy<RsaSecurityKey> key;

    public McpIdentityAssertionIssuer(IOptions<McpIdentityAssertionOptions> configured)
    {
        options = configured.Value;
        key = new Lazy<RsaSecurityKey>(CreateKey, LazyThreadSafetyMode.ExecutionAndPublication);
    }

    public (string Assertion, DateTimeOffset ExpiresAt) Create(UserProfile user, string audience)
    {
        if (string.IsNullOrWhiteSpace(audience)) throw new InvalidOperationException("MCP assertion audience is not configured");
        var now = DateTimeOffset.UtcNow;
        var lifetime = Math.Clamp(options.LifetimeSeconds, 30, 120);
        var expires = now.AddSeconds(lifetime);
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.EmployeeNo.ToLowerInvariant()),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("D")),
            new(JwtRegisteredClaimNames.Name, user.Name),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new(JwtRegisteredClaimNames.Iat, now.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
            new("aigc_user_id", user.Id.ToString("D"))
        };
        if (user.DepartmentId is Guid departmentId) claims.Add(new("department_id", departmentId.ToString("D")));
        var token = new JwtSecurityToken(options.Issuer, audience, claims, now.UtcDateTime.AddSeconds(-5),
            expires.UtcDateTime, new SigningCredentials(key.Value, SecurityAlgorithms.RsaSha256));
        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
    }

    private RsaSecurityKey CreateKey()
    {
        if (string.IsNullOrWhiteSpace(options.KeyId) || string.IsNullOrWhiteSpace(options.PrivateKeyPem))
            throw new InvalidOperationException("MCP identity assertion signing key is not configured");
        var rsa = RSA.Create();
        try { rsa.ImportFromPem(options.PrivateKeyPem); }
        catch { rsa.Dispose(); throw; }
        return new RsaSecurityKey(rsa) { KeyId = options.KeyId };
    }
}
