using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

public sealed record CasIdentity(string EmployeeNo, string Name, string Email, string? OrgId);

/// <summary>Shared CAS ticket validation and ordinary AIGC user provisioning.</summary>
public sealed class CasAuthenticationService(IHttpClientFactory clients, IOptions<CasOptions> configured,
    AigcHubDbContext db, IPasswordHasher<AppUser> hasher)
{
    public async Task<CasIdentity?> ValidateAsync(string ticket, string service, CancellationToken ct)
    {
        var options = configured.Value;
        if (!options.Enabled || string.IsNullOrWhiteSpace(ticket)) return null;
        var url = Microsoft.AspNetCore.WebUtilities.QueryHelpers.AddQueryString(options.ValidateUrl,
            new Dictionary<string, string?> { ["service"] = service, ["ticket"] = ticket });
        using var response = await clients.CreateClient("bhss-cas").GetAsync(url, ct);
        if (!response.IsSuccessStatusCode) return null;
        XDocument document;
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = XmlReader.Create(stream, new XmlReaderSettings
            {
                Async = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                MaxCharactersInDocument = 1024 * 1024
            });
            document = await XDocument.LoadAsync(reader, LoadOptions.None, ct);
        }
        catch (Exception exception) when (exception is XmlException or InvalidOperationException) { return null; }
        var success = document.Descendants().FirstOrDefault(x => x.Name.LocalName == "authenticationSuccess");
        if (success is null) return null;
        string? Value(string name) => success.Descendants().FirstOrDefault(x => x.Name.LocalName == name)?.Value.Trim();
        var employeeNo = (Value("logonCode") ?? Value("employeeId") ?? Value("user"))?.Trim().ToLowerInvariant();
        if (employeeNo is null || !Regex.IsMatch(employeeNo, "^[a-z0-9_-]{1,64}$", RegexOptions.CultureInvariant)) return null;
        return new CasIdentity(employeeNo, Value("name") ?? employeeNo,
            Value("eMail") ?? Value("email") ?? $"{employeeNo}@bhss.local", Value("orgId"));
    }

    public async Task<AppUser> FindOrCreateUserAsync(CasIdentity identity, CancellationToken ct)
    {
        var user = await db.Users.Include(x => x.Department).Include(x => x.Roles)
            .ThenInclude(x => x.Role).ThenInclude(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleOrDefaultAsync(x => x.EmployeeNo.ToLower() == identity.EmployeeNo, ct);
        if (user is not null) return user;
        if (await db.Users.AnyAsync(x => x.Email.ToLower() == identity.Email.ToLower(), ct))
            throw new InvalidOperationException("SSO 邮箱已由其他工号使用，请联系管理员核对账号。");
        var department = identity.OrgId is null ? null
            : await db.Departments.SingleOrDefaultAsync(x => x.Code.ToLower() == identity.OrgId.ToLower() && x.IsEnabled, ct);
        department ??= await db.Departments.SingleAsync(x => x.Code == configured.Value.DefaultDepartmentCode && x.IsEnabled, ct);
        var role = await db.Roles.Include(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleAsync(x => x.Code == "normal-user", ct);
        user = new AppUser { EmployeeNo = identity.EmployeeNo, Name = identity.Name, Email = identity.Email, Department = department, PasswordHash = "" };
        // CAS-created accounts have no shared, guessable local password. Administrators may reset it explicitly.
        user.PasswordHash = hasher.HashPassword(user, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
        user.Roles.Add(new UserRole { User = user, Role = role });
        db.Users.Add(user);
        return user;
    }
}
