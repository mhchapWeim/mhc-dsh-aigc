using System.Security.Claims;
using System.Security.Cryptography;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

/// <summary>First-install downloads use Portal identity, without registering a desktop device.</summary>
public static class DesktopDownloadEndpoints
{
    private static string Cookie(Guid id) => $"aigc-desktop-download-{id:N}";
    private static string InstallerPath(Guid id) => $"/api/desktop-downloads/{id}/installer";
    private static ITimeLimitedDataProtector Protector(IDataProtectionProvider provider) =>
        provider.CreateProtector("AigcHub.DesktopDownload.v1").ToTimeLimitedDataProtector();

    public static void MapDesktopDownloadEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/desktop-downloads").WithTags("桌面客户端下载");
        group.MapGet("/windows-x64", LatestAsync).RequireAuthorization("portal.view");
        group.MapPost("/{id:guid}/ticket", TicketAsync).RequireAuthorization("portal.view");
        group.MapGet("/{id:guid}/installer", DownloadAsync).AllowAnonymous();
    }

    private static async Task<DesktopRelease?> EligibleAsync(Guid id, Guid userId, AigcHubDbContext db, CancellationToken ct) =>
        await db.DesktopReleases.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.Status == "Published"
            && x.Platform == "win32" && x.Arch == "x64" && x.Bytes > 0
            && x.Recipients.Any(r => r.UserId == userId && r.User.IsEnabled), ct);

    private static string FilePath(Guid id, IConfiguration config, IWebHostEnvironment env) =>
        Path.Combine(Path.GetFullPath(config["DesktopReleases:Root"] ?? Path.Combine(env.ContentRootPath, "data", "desktop-releases")), id.ToString("N"), "installer.exe");

    private static async Task<IResult> LatestAsync(HttpContext context, AigcHubDbContext db,
        IConfiguration config, IWebHostEnvironment env, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out var userId)) return Results.Unauthorized();
        var releases = await db.DesktopReleases.AsNoTracking().Where(x => x.Status == "Published" && x.Platform == "win32"
            && x.Arch == "x64" && x.Bytes > 0 && x.Recipients.Any(r => r.UserId == userId && r.User.IsEnabled)).ToArrayAsync(ct);
        var release = releases.Where(x => DesktopVersion.Valid(x.Version) && File.Exists(FilePath(x.Id, config, env)))
            .OrderByDescending(x => x.Version, Comparer<string>.Create(DesktopVersion.Compare)).ThenByDescending(x => x.CreatedAt).FirstOrDefault();
        return Results.Ok(new { release = release is null ? null : new { release.Id, release.Version, release.Notes, release.Bytes,
            release.Sha512, release.FileName, release.CreatedAt, platform = "Windows x64" } });
    }

    private static async Task<IResult> TicketAsync(Guid id, HttpContext context, AigcHubDbContext db,
        IConfiguration config, IWebHostEnvironment env, IDataProtectionProvider protection, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out var userId)) return Results.Unauthorized();
        if (await EligibleAsync(id, userId, db, ct) is null || !File.Exists(FilePath(id, config, env))) return Results.NotFound();
        var token = Protector(protection).Protect($"{userId:N}:{id:N}", TimeSpan.FromMinutes(10));
        context.Response.Cookies.Append(Cookie(id), token, new CookieOptions { HttpOnly = true,
            Secure = context.Request.IsHttps || config["Cas:PublicBaseUrl"]?.StartsWith("https://", StringComparison.OrdinalIgnoreCase) == true,
            SameSite = SameSiteMode.Lax, Path = InstallerPath(id), MaxAge = TimeSpan.FromMinutes(10) });
        return Results.Ok(new { path = InstallerPath(id) });
    }

    private static async Task<IResult> DownloadAsync(Guid id, HttpContext context, AigcHubDbContext db,
        IConfiguration config, IWebHostEnvironment env, IDataProtectionProvider protection, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        var token = context.Request.Cookies[Cookie(id)];
        if (token is null) return Results.Unauthorized();
        string payload;
        try { payload = Protector(protection).Unprotect(token); }
        catch (CryptographicException) { return Results.Unauthorized(); }
        var parts = payload.Split(':');
        if (parts.Length != 2 || parts[1] != id.ToString("N") || !Guid.TryParse(parts[0], out var userId)) return Results.Unauthorized();
        var release = await EligibleAsync(id, userId, db, ct);
        var path = FilePath(id, config, env);
        if (release is null || !File.Exists(path)) return Results.NotFound();
        var user = await db.Users.AsNoTracking().SingleAsync(x => x.Id == userId, ct);
        RequestLoggingMiddleware.Identify(context, user.Id, user.EmployeeNo, user.Name);
        loggerFactory.CreateLogger("DesktopDownloads").LogInformation("Desktop installer download ReleaseId={ReleaseId} Version={Version}", id, release.Version);
        return Results.File(path, "application/octet-stream", fileDownloadName: release.FileName, enableRangeProcessing: true);
    }
}
