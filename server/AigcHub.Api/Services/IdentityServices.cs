using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace AigcHub.Api.Services;

public sealed class JwtOptions
{
    public string Issuer { get; set; } = "AigcHub";
    public string Audience { get; set; } = "AigcHub.Portal";
    public string Key { get; set; } = "development-only-change-this-key-to-at-least-32-characters";
    public int ExpiresMinutes { get; set; } = 480;
}

public sealed class CasOptions
{
    public bool Enabled { get; set; }
    public string LoginUrl { get; set; } = "https://sso.boschhuayu-steering.com/cas/login";
    public string LogoutUrl { get; set; } = "https://sso.boschhuayu-steering.com/cas/logout";
    public string ValidateUrl { get; set; } = "https://sso.boschhuayu-steering.com/cas/serviceValidate";
    public string ServiceUrl { get; set; } = "";
    public string PublicBaseUrl { get; set; } = "";
    public string PortalBaseUrl { get; set; } = "";
    public bool VerifySsl { get; set; } = true;
    public int RequestTimeoutSeconds { get; set; } = 10;
    public string InitialPassword { get; set; } = "Bhss@123";
    public string DefaultDepartmentCode { get; set; } = "digital";
}

public interface ICurrentUser
{
    Guid Id { get; }
}

public sealed class CurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public Guid Id => Guid.TryParse(accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier), out var id)
        ? id : throw new UnauthorizedAccessException("未登录或令牌无效");
}

public sealed class TokenService(IOptions<JwtOptions> options)
{
    private readonly JwtOptions _options = options.Value;

    public LoginResponse Create(AppUser user, string[] roles, string[] permissions)
    {
        var expires = DateTimeOffset.UtcNow.AddMinutes(_options.ExpiresMinutes);
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id.ToString()),
            new(ClaimTypes.Name, user.Name),
            new("employee_no", user.EmployeeNo)
        };
        claims.AddRange(roles.Select(x => new Claim(ClaimTypes.Role, x)));
        claims.AddRange(permissions.Select(x => new Claim("permission", x)));
        var token = new JwtSecurityToken(_options.Issuer, _options.Audience, claims,
            expires: expires.UtcDateTime,
            signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_options.Key)), SecurityAlgorithms.HmacSha256));
        var profile = new UserProfile(user.Id, user.EmployeeNo, user.Name, user.Email, user.DepartmentId,
            user.Department?.Name ?? "", roles, permissions);
        return new LoginResponse(new JwtSecurityTokenHandler().WriteToken(token), expires, profile);
    }
}

public static class IdentityQueries
{
    public static async Task<UserProfile?> ProfileAsync(AigcHubDbContext db, Guid userId, CancellationToken ct)
    {
        var user = await db.Users.Include(x => x.Department).Include(x => x.Roles).ThenInclude(x => x.Role)
            .ThenInclude(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleOrDefaultAsync(x => x.Id == userId && x.IsEnabled, ct);
        if (user is null) return null;
        var roles = user.Roles.Select(x => x.Role.Name).Distinct().ToArray();
        var permissions = user.Roles.SelectMany(x => x.Role.Permissions).Select(x => x.Permission.Code).Distinct().ToArray();
        return new UserProfile(user.Id, user.EmployeeNo, user.Name, user.Email, user.DepartmentId,
            user.Department?.Name ?? "", roles, permissions);
    }
}
