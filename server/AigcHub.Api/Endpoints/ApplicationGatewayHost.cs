using System.Collections.Concurrent;
using System.Net;
using AigcHub.Api.Configuration;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using HeaderNames = Microsoft.Net.Http.Headers.HeaderNames;
using SetCookieHeaderValue = Microsoft.Net.Http.Headers.SetCookieHeaderValue;
using Yarp.ReverseProxy.Forwarder;

namespace AigcHub.Api.Endpoints;

public static class ApplicationGatewayHost
{
    public const string CookieName = "aigc_app_session";
    internal const string ProxyCookieName = "__Host-aigc_app_session";
    internal const string ProxyLaunchPath = "/.aigc/launch";

    internal static string? GetProxyHostSuffix(IConfiguration configuration)
    {
        var suffix = configuration["ApplicationGateway:ProxyHostSuffix"]?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(suffix)) return null;
        if (suffix.Length > 189 || Uri.CheckHostName(suffix) != UriHostNameType.Dns ||
            !System.Text.RegularExpressions.Regex.IsMatch(suffix, @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"))
            throw new InvalidOperationException("ApplicationGateway:ProxyHostSuffix 必须是 DNS 后缀，不含通配符、协议或端口");
        return suffix;
    }

    public static void UseApplicationGateway(this WebApplication app)
    {
        var proxyHostSuffix = GetProxyHostSuffix(app.Configuration);
        app.Use(async (context, next) =>
        {
            if (proxyHostSuffix is not null && context.Request.Host.Host.EndsWith($".{proxyHostSuffix}", StringComparison.OrdinalIgnoreCase))
            {
                var host = context.Request.Host.Host;
                var proxySlug = host[..^(proxyHostSuffix.Length + 1)].ToLowerInvariant();
                if (!IsSlug(proxySlug) || proxySlug.EndsWith('-'))
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                var proxyOrigin = new Uri($"https://{proxySlug}.{proxyHostSuffix}");
                if (context.Request.Path == ProxyLaunchPath)
                {
                    if (!HttpMethods.IsPost(context.Request.Method))
                    {
                        context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
                        return;
                    }
                    await RedeemAsync(context, proxySlug, proxyOrigin, context.RequestAborted);
                    return;
                }
                await ForwardAsync(context, proxySlug, null, "请从 AIGC 应用集合进入此应用", context.RequestAborted, proxyOrigin);
                return;
            }
            var segments = (context.Request.Path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (segments.Length == 0 || !IsSlug(segments[0]))
            {
                await next();
                return;
            }
            var slug = segments[0];
            var rest = segments.Length == 1 ? null : string.Join('/', segments.Skip(1));
            if (rest is null) await HandleRoot(context, slug, context.RequestAborted);
            else await HandleDeep(context, slug, rest, context.RequestAborted);
        });
    }

    private static async Task HandleRoot(HttpContext context, string slug, CancellationToken ct)
    {
        if (!IsSlug(slug)) { context.Response.StatusCode = 404; return; }
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method) && !HttpMethods.IsPost(context.Request.Method))
        {
            context.Response.StatusCode = 405;
            return;
        }
        if (HttpMethods.IsPost(context.Request.Method))
        {
            await RedeemAsync(context, slug, null, ct);
            return;
        }
        await ForwardAsync(context, slug, null, "请从 AIGC 应用集合进入此应用", ct);
    }

    private static Task HandleDeep(HttpContext context, string slug, string? rest, CancellationToken ct) =>
        ForwardAsync(context, slug, rest, "请从 AIGC 应用集合打开此应用", ct);

    private static async Task ForwardAsync(HttpContext context, string slug, string? rest, string missingSessionMessage,
        CancellationToken ct, Uri? proxyOrigin = null)
    {
        var sessions = context.RequestServices.GetRequiredService<GatewaySessionService>();
        var db = context.RequestServices.GetRequiredService<AigcHubDbContext>();
        var forwarder = context.RequestServices.GetRequiredService<IHttpForwarder>();
        var configuration = context.RequestServices.GetRequiredService<IConfiguration>();
        if (!IsSlug(slug)) { context.Response.StatusCode = 404; return; }
        var route = await db.ApplicationRoutes.AsNoTracking().SingleOrDefaultAsync(x => x.Slug == slug, ct);
        if (route is null || route.Status != ApplicationRouteService.Ready)
        {
            context.Response.StatusCode = route is null && proxyOrigin is not null ? 404 : 403;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("应用路由未就绪", ct);
            return;
        }
        var activity = GatewaySessionService.CountsAsActivity(context.Request.Path.Value ?? "",
            context.Request.Headers["X-Aigc-Activity"], context.Request.Query.ContainsKey("poll"));
        var cookieName = proxyOrigin is null ? CookieName : ProxyCookieName;
        var session = await sessions.AuthorizeAsync(context.Request.Cookies[cookieName], route.PublicationRequestId, activity, ct);
        if (session is null)
        {
            ClearCookie(context, cookieName, proxyOrigin is not null);
            if (context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 401; return; }
            await WriteNoticeAsync(context, missingSessionMessage);
            return;
        }
        if (!Uri.TryCreate(route.UpstreamUrl, UriKind.Absolute, out var upstream))
        {
            await WriteUpstreamErrorAsync(context, ct);
            return;
        }
        var invoker = ApplicationConfiguration.CanAcceptInvalidGatewayCertificate(configuration, upstream)
            ? context.RequestServices.GetRequiredKeyedService<HttpMessageInvoker>(ApplicationConfiguration.GatewayUntrustedUpstream)
            : context.RequestServices.GetRequiredService<HttpMessageInvoker>();
        var prefix = upstream.GetLeftPart(UriPartial.Authority);
        if (proxyOrigin is null)
        {
            var basePath = upstream.AbsolutePath.TrimEnd('/');
            var suffix = string.IsNullOrEmpty(rest) ? "/" : "/" + rest;
            context.Request.Path = basePath + suffix;
        }
        var remaining = session.AbsoluteExpiresAt - DateTimeOffset.UtcNow;
        var idleLeft = session.LastActivityAt.AddSeconds(session.IdleTimeoutSeconds) - DateTimeOffset.UtcNow;
        var timeout = remaining < idleLeft ? remaining : idleLeft;
        if (timeout < TimeSpan.FromSeconds(1)) timeout = TimeSpan.FromSeconds(1);
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        GatewaySockets.Register(session.Id, cts);
        try
        {
            var error = await forwarder.SendAsync(context, prefix, invoker, new ForwarderRequestConfig { ActivityTimeout = timeout },
                new UpstreamTransformer(slug, upstream, configuration["ApplicationGateway:PublicOrigin"] ?? "", proxyOrigin), cts.Token);
            if (error != ForwarderError.None)
            {
                var transportError = (context.GetForwarderErrorFeature()?.Exception as HttpRequestException)?.HttpRequestError;
                context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("ApplicationGateway")
                    .LogWarning("Application gateway forwarding failed for {Slug}: {ForwarderError}, transport error {TransportError}",
                        slug, error, transportError);
                if (!context.Response.HasStarted && !ct.IsCancellationRequested)
                    await WriteUpstreamErrorAsync(context, ct);
            }
        }
        finally
        {
            GatewaySockets.Release(session.Id, cts);
            cts.Dispose();
        }
    }

    private static Task WriteUpstreamErrorAsync(HttpContext context, CancellationToken ct)
    {
        const string message = "应用暂时无法访问";
        var encoded = System.Text.Encodings.Web.HtmlEncoder.Default.Encode(message);
        context.Response.Clear();
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        context.Response.ContentType = "text/html; charset=utf-8";
        return context.Response.WriteAsync(
            $"<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>{encoded}</title></head><body><h1>{encoded}</h1></body></html>", ct);
    }

    private static async Task RedeemAsync(HttpContext context, string slug, Uri? proxyOrigin, CancellationToken ct)
    {
        var tickets = context.RequestServices.GetRequiredService<LaunchTicketService>();
        var sessions = context.RequestServices.GetRequiredService<GatewaySessionService>();
        var db = context.RequestServices.GetRequiredService<AigcHubDbContext>();
        if (!OriginAllowed(context))
        {
            context.Response.StatusCode = 403;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("启动请求来源不被接受", ct);
            return;
        }
        if (!context.Request.HasFormContentType) { context.Response.StatusCode = 400; return; }
        var form = await context.Request.ReadFormAsync(ct);
        var token = form["ticket"].ToString();
        if (token.Contains('\r') || token.Contains('\n')) { context.Response.StatusCode = 400; return; }
        var route = await db.ApplicationRoutes.AsNoTracking().SingleOrDefaultAsync(x => x.Slug == slug && x.Status == ApplicationRouteService.Ready, ct);
        var consumed = route is null ? null : await tickets.ConsumeAsync(token, route.PublicationRequestId, ct);
        if (route is null || consumed is null)
        {
            context.Response.StatusCode = 403;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("启动票据无效、已使用或已过期", ct);
            return;
        }
        var opened = await sessions.OpenAsync(consumed, ct);
        if (opened is null)
        {
            context.Response.StatusCode = 403;
            context.Response.ContentType = "text/plain; charset=utf-8";
            await context.Response.WriteAsync("应用已停用或启动票据已失效", ct);
            return;
        }
        var secure = proxyOrigin is not null || context.Request.IsHttps || string.Equals(context.Request.Headers["X-Forwarded-Proto"], "https", StringComparison.OrdinalIgnoreCase);
        context.Response.Cookies.Append(proxyOrigin is null ? CookieName : ProxyCookieName, opened.Value.Secret, new CookieOptions
        {
            HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Lax, Path = "/", IsEssential = true,
            MaxAge = opened.Value.Session.AbsoluteExpiresAt - DateTimeOffset.UtcNow
        });
        context.Response.StatusCode = StatusCodes.Status303SeeOther;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Location = proxyOrigin is not null && Uri.TryCreate(route.UpstreamUrl, UriKind.Absolute, out var upstream)
            ? proxyOrigin.GetLeftPart(UriPartial.Authority) + upstream.PathAndQuery
            : $"/{slug}/";
    }

    private static bool OriginAllowed(HttpContext context)
    {
        var origin = context.Request.Headers.Origin.ToString().TrimEnd('/');
        var allowed = context.RequestServices.GetRequiredService<IConfiguration>().GetSection("ApplicationGateway:AllowedSubmitOrigins").Get<string[]>() ?? [];
        var fallback = context.RequestServices.GetRequiredService<IConfiguration>()["ApplicationGateway:PublicOrigin"]?.TrimEnd('/');
        if (allowed.Length == 0 && !string.IsNullOrEmpty(fallback)) allowed = [fallback];
        return allowed.Any(item => string.Equals(item.TrimEnd('/'), origin, StringComparison.OrdinalIgnoreCase));
    }

    private static async Task WriteNoticeAsync(HttpContext context, string message)
    {
        var home = context.RequestServices.GetRequiredService<IConfiguration>()["ApplicationGateway:PortalHome"];
        if (!Uri.TryCreate(home, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http")) home = "/";
        context.Response.StatusCode = 401;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.ContentType = "text/html; charset=utf-8";
        var safeHome = WebUtility.HtmlEncode(home);
        var safeMessage = WebUtility.HtmlEncode(message);
        await context.Response.WriteAsync($$"""
            <!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>AIGC 应用集合</title>
            <style>body{font-family:Segoe UI,sans-serif;background:#f4f6f8;color:#1c2430;display:grid;place-items:center;min-height:100vh;margin:0}
            main{max-width:32rem;padding:2rem;background:#fff;border:1px solid #d5dde6;border-radius:12px} a{display:inline-block;margin-top:1rem;color:#0b4f9c}</style>
            </head><body><main><h1>{{safeMessage}}</h1><p>会话过期、权限收回或应用下架后，需要重新从应用集合打开。</p>
            <a href="{{safeHome}}">返回 AIGC 应用集合</a></main></body></html>
            """);
    }

    private static void ClearCookie(HttpContext context, string name, bool secure) =>
        context.Response.Cookies.Delete(name, new CookieOptions { HttpOnly = true, Secure = secure || context.Request.IsHttps, SameSite = SameSiteMode.Lax, Path = "/" });

    private static bool IsSlug(string slug) => System.Text.RegularExpressions.Regex.IsMatch(slug, "^[a-z0-9][a-z0-9-]{1,62}$")
        && slug is not ("api" or "admin" or "health" or "swagger" or "hubs" or "login" or "desktop" or "apps");

    public static int CloseUnauthorized(IEnumerable<Guid> stillValid)
    {
        var valid = stillValid.ToHashSet();
        return GatewaySockets.CloseExcept(valid);
    }
}

public static class GatewaySockets
{
    private static readonly ConcurrentDictionary<Guid, ConcurrentDictionary<CancellationTokenSource, byte>> Items = new();
    public static void Register(Guid sessionId, CancellationTokenSource cts) =>
        Items.GetOrAdd(sessionId, _ => new()).TryAdd(cts, 0);
    public static void Release(Guid sessionId, CancellationTokenSource cts)
    {
        if (Items.TryGetValue(sessionId, out var set)) set.TryRemove(cts, out _);
    }
    public static int CloseExcept(HashSet<Guid> valid)
    {
        var closed = 0;
        foreach (var pair in Items)
        {
            if (valid.Contains(pair.Key)) continue;
            foreach (var cts in pair.Value.Keys)
            {
                try { cts.Cancel(); closed++; } catch (ObjectDisposedException) { }
            }
        }
        return closed;
    }
}

sealed class UpstreamTransformer(string slug, Uri upstream, string publicOrigin, Uri? proxyOrigin) : HttpTransformer
{
    public override async ValueTask TransformRequestAsync(HttpContext context, HttpRequestMessage proxyRequest, string destinationPrefix, CancellationToken cancellationToken)
    {
        await HttpTransformer.Default.TransformRequestAsync(context, proxyRequest, destinationPrefix, cancellationToken);
        proxyRequest.Headers.Remove("Cookie");
        proxyRequest.Headers.Remove("X-Aigc-Ticket");
        if (proxyOrigin is null)
        {
            proxyRequest.Headers.Remove("Authorization");
            return;
        }

        proxyRequest.Headers.Host = null;
        proxyRequest.Headers.Remove("Forwarded");
        proxyRequest.Headers.Remove("X-Forwarded-Prefix");
        proxyRequest.Headers.Remove("X-Forwarded-Port");
        proxyRequest.Headers.Remove("X-Aigc-Activity");
        SetHeader(proxyRequest, "X-Forwarded-Host", proxyOrigin.Authority);
        SetHeader(proxyRequest, "X-Forwarded-Proto", proxyOrigin.Scheme);
        var businessCookies = context.Request.Headers.Cookie.SelectMany(value => (value ?? "")
            .Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            .Where(cookie => cookie.IndexOf('=') is var separator && separator > 0 && !IsAigcCookie(cookie[..separator].Trim()));
        var cookieHeader = string.Join("; ", businessCookies);
        if (cookieHeader.Length > 0)
            proxyRequest.Headers.TryAddWithoutValidation("Cookie", cookieHeader);

        // Translate the app's same-origin requests for upstream CSRF checks, retaining external origins.
        var origin = context.Request.Headers.Origin.ToString();
        if (string.Equals(origin, proxyOrigin.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase))
            SetHeader(proxyRequest, "Origin", upstream.GetLeftPart(UriPartial.Authority));
        if (proxyRequest.Headers.Referrer is Uri referer && SameOrigin(referer, proxyOrigin))
            proxyRequest.Headers.Referrer = new Uri(upstream.GetLeftPart(UriPartial.Authority) + referer.PathAndQuery);
    }

    public override async ValueTask<bool> TransformResponseAsync(HttpContext context, HttpResponseMessage? proxyResponse, CancellationToken cancellationToken)
    {
        var suppress = await base.TransformResponseAsync(context, proxyResponse, cancellationToken);
        if (proxyOrigin is not null && proxyResponse is not null)
        {
            var proxyLocation = proxyResponse.Headers.Location;
            if (proxyLocation is not null && (proxyLocation.IsAbsoluteUri || proxyLocation.OriginalString.StartsWith("//", StringComparison.Ordinal)) &&
                Uri.TryCreate(upstream, proxyLocation, out var destination) && SameOrigin(destination, upstream))
                context.Response.Headers.Location = proxyOrigin.GetLeftPart(UriPartial.Authority) + destination.PathAndQuery + destination.Fragment;

            var setCookies = context.Response.Headers.SetCookie;
            context.Response.Headers.Remove(HeaderNames.SetCookie);
            foreach (var value in setCookies)
            {
                if (!SetCookieHeaderValue.TryParse(value, out var cookie) || IsAigcCookie(cookie.Name.ToString())) continue;
                var domain = cookie.Domain.ToString().TrimStart('.');
                if (domain.Length > 0 && !string.Equals(upstream.IdnHost, domain, StringComparison.OrdinalIgnoreCase) &&
                    !upstream.IdnHost.EndsWith($".{domain}", StringComparison.OrdinalIgnoreCase)) continue;
                // A backend cookie must stay on this proxy hostname, even when the business origin sets a Domain.
                cookie.Domain = default;
                context.Response.Headers.Append(HeaderNames.SetCookie, cookie.ToString());
            }
            // Browsers can apply “cookies” to the whole registrable domain, including other applications.
            context.Response.Headers.Remove("Clear-Site-Data");
            return suppress;
        }
        if (proxyResponse?.Headers.Location is Uri location && Uri.TryCreate(publicOrigin, UriKind.Absolute, out var origin))
        {
            var upstreamBase = upstream.AbsolutePath.TrimEnd('/');
            var path = location.IsAbsoluteUri ? location.AbsolutePath : location.OriginalString;
            if (!string.IsNullOrEmpty(upstreamBase) && path.StartsWith(upstreamBase, StringComparison.Ordinal)) path = path[upstreamBase.Length..];
            if (!path.StartsWith('/')) path = "/" + path;
            var query = location.IsAbsoluteUri ? location.Query.TrimStart('?') : "";
            context.Response.Headers.Location = string.IsNullOrEmpty(query) ? $"{origin.GetLeftPart(UriPartial.Authority)}/{slug}{path}" : $"{origin.GetLeftPart(UriPartial.Authority)}/{slug}{path}?{query}";
        }
        return suppress;
    }

    private static bool SameOrigin(Uri left, Uri right) => left.IsAbsoluteUri &&
        string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(left.IdnHost, right.IdnHost, StringComparison.OrdinalIgnoreCase) && left.Port == right.Port;

    private static bool IsAigcCookie(string name)
    {
        if (name.StartsWith("__Host-", StringComparison.OrdinalIgnoreCase)) name = name["__Host-".Length..];
        if (name.StartsWith("__Secure-", StringComparison.OrdinalIgnoreCase)) name = name["__Secure-".Length..];
        return name.StartsWith("aigc_", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("aigc-", StringComparison.OrdinalIgnoreCase);
    }

    private static void SetHeader(HttpRequestMessage message, string name, string value)
    {
        message.Headers.Remove(name);
        message.Headers.TryAddWithoutValidation(name, value);
    }
}
