using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

/// <summary>Short-lived, encrypted browser correlation and completion cookies; JWTs never enter redirect URLs.</summary>
public sealed class PortalSsoFlow(IDataProtectionProvider protection, IOptions<CasOptions> configured)
{
    public const string PendingCookie = "aigc-portal-sso-pending";
    public const string CompletionCookie = "aigc-portal-sso-completion";
    private readonly ITimeLimitedDataProtector _pending = protection.CreateProtector("AigcHub.PortalSso.Pending.v1").ToTimeLimitedDataProtector();
    private readonly ITimeLimitedDataProtector _completion = protection.CreateProtector("AigcHub.PortalSso.Completion.v1").ToTimeLimitedDataProtector();
    public sealed record Pending(string State, string ReturnTo);
    public sealed record Completion(Guid UserId);

    public Uri? PortalUri
    {
        get
        {
            var options = configured.Value;
            var url = string.IsNullOrWhiteSpace(options.PortalBaseUrl) ? options.PublicBaseUrl : options.PortalBaseUrl;
            return Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
                && string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment) ? uri : null;
        }
    }
    public bool Enabled => configured.Value.Enabled && PortalUri is not null
        && Uri.TryCreate(configured.Value.ServiceUrl, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";
    public string Service(string state) => QueryHelpers.AddQueryString(configured.Value.ServiceUrl, "portal_state", state);
    public string LoginPage(string status, string returnTo = "/") => QueryHelpers.AddQueryString(
        $"{PortalUri!.AbsoluteUri.TrimEnd('/')}/login", new Dictionary<string, string?> { ["sso"] = status, ["returnTo"] = returnTo });
    public static string SafeReturnTo(string? value)
    {
        if (value is not { Length: > 0 and <= 2048 }) return "/";
        var decoded = Uri.UnescapeDataString(value);
        return decoded.StartsWith('/') && !decoded.StartsWith("//") && !decoded.Any(c => c == '\\' || char.IsControl(c))
            && decoded.Split('?', '#')[0] is not ("/login" or "/login/local") ? value : "/";
    }

    public Pending Start(HttpRequest request, HttpResponse response, string? returnTo)
    {
        Clear(response);
        response.Cookies.Delete("aigc-cas-device", new CookieOptions { Path = "/v1/auth/cas" });
        var pending = new Pending(Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), SafeReturnTo(returnTo));
        response.Cookies.Append(PendingCookie, _pending.Protect(JsonSerializer.Serialize(pending), TimeSpan.FromMinutes(5)), Cookie(request, TimeSpan.FromMinutes(5)));
        return pending;
    }
    public Pending? ReadPending(HttpRequest request)
    {
        if (!request.Cookies.TryGetValue(PendingCookie, out var value)) return null;
        try { return JsonSerializer.Deserialize<Pending>(_pending.Unprotect(value)); }
        catch (Exception exception) when (exception is CryptographicException or JsonException) { return null; }
    }
    public void Complete(HttpRequest request, HttpResponse response, Guid userId)
    {
        response.Cookies.Delete(PendingCookie, new CookieOptions { Path = "/" });
        response.Cookies.Append(CompletionCookie, _completion.Protect(JsonSerializer.Serialize(new Completion(userId)), TimeSpan.FromMinutes(1)), Cookie(request, TimeSpan.FromMinutes(1)));
    }
    public Completion? ReadCompletion(HttpRequest request)
    {
        if (!request.Cookies.TryGetValue(CompletionCookie, out var value)) return null;
        try { return JsonSerializer.Deserialize<Completion>(_completion.Unprotect(value)); }
        catch (Exception exception) when (exception is CryptographicException or JsonException) { return null; }
    }
    public bool AcceptsOrigin(HttpRequest request) => PortalUri is { } portal
        && Uri.TryCreate(request.Headers.Origin.ToString(), UriKind.Absolute, out var origin)
        && string.Equals(origin.GetLeftPart(UriPartial.Authority), portal.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase);
    public static void Clear(HttpResponse response)
    {
        response.Cookies.Delete(PendingCookie, new CookieOptions { Path = "/" });
        response.Cookies.Delete(CompletionCookie, new CookieOptions { Path = "/" });
    }
    private CookieOptions Cookie(HttpRequest request, TimeSpan age) => new()
    {
        HttpOnly = true, Secure = request.IsHttps || PortalUri?.Scheme == "https", SameSite = SameSiteMode.Lax,
        Path = "/", MaxAge = age, IsEssential = true
    };
}
