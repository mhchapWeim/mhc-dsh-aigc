using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class DesktopDistributionEndpoints
{
    private const long MaximumPackageBytes = 2L * 1024 * 1024 * 1024;
    private static readonly SemaphoreSlim ReleaseGate = new(1, 1);
    private static readonly SemaphoreSlim ReportGate = new(1, 1);
    private sealed record AnnouncementInput(string Title, string Body, bool Important, DateTimeOffset StartsAt,
        DateTimeOffset? EndsAt, Guid[] UserIds, Guid[]? RoleIds = null, Guid[]? DepartmentIds = null);
    private sealed record ReleaseInput(string Version, string Notes, string Arch, Guid[] UserIds, Guid[]? RoleIds = null, Guid[]? DepartmentIds = null);
    private sealed record StatusInput(string Status);
    private sealed record TargetsInput(Guid[] UserIds, Guid[]? RoleIds = null, Guid[]? DepartmentIds = null);
    private sealed record ReceiptInput(string Status);
    private sealed record ClientInput(string DeviceId, string ComputerName, string Version, string Platform, string Arch,
        string UpdateStatus = "Current", string TargetVersion = "", string Error = "");

    public static void MapDesktopDistributionEndpoints(this IEndpointRouteBuilder app)
    {
        var announcements = app.MapGroup("/api/desktop-announcements").WithTags("客户端公告").RequireAuthorization("announcement.manage");
        announcements.MapGet("/", ListAnnouncementsAsync);
        announcements.MapGet("/recipients", UsersAsync);
        announcements.MapGet("/recipient-options", AudienceOptionsAsync);
        announcements.MapPost("/", CreateAnnouncementAsync);
        announcements.MapPut("/{id:guid}", EditAnnouncementAsync);
        announcements.MapPost("/{id:guid}/status", AnnouncementStatusAsync);
        var releases = app.MapGroup("/api/desktop-releases").WithTags("客户端灰度发布").RequireAuthorization("client-release.manage");
        releases.MapGet("/", ListReleasesAsync);
        releases.MapGet("/recipients", UsersAsync);
        releases.MapGet("/recipient-options", AudienceOptionsAsync);
        releases.MapGet("/clients", ListClientsAsync);
        releases.MapPost("/", CreateReleaseAsync);
        releases.MapPut("/{id:guid}/recipients", ReleaseTargetsAsync);
        releases.MapPost("/{id:guid}/status", ReleaseStatusAsync);
        releases.MapPost("/{id:guid}/artifacts", UploadAsync).DisableAntiforgery()
            .WithMetadata(new RequestSizeLimitAttribute(MaximumPackageBytes + 32 * 1024 * 1024),
                new RequestFormLimitsAttribute { MultipartBodyLengthLimit = MaximumPackageBytes + 32 * 1024 * 1024 });
        var desktop = app.MapGroup("/v1/desktop").WithTags("DSH 公告与更新");
        desktop.MapGet("/announcements", InboxAsync);
        desktop.MapPost("/announcements/{id:guid}/receipt", ReceiptAsync);
        desktop.MapPost("/check", CheckAsync);
        desktop.MapGet("/updates/{id:guid}/{file}", DownloadAsync);
    }

    private static async Task<IResult> UsersAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(
        await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo)
            .Select(x => new { x.Id, x.Name, x.EmployeeNo }).ToArrayAsync(ct));

    private static async Task<IResult> AudienceOptionsAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(new
    {
        users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.EmployeeNo)
            .Select(x => new { x.Id, x.Name, x.EmployeeNo, x.DepartmentId, roleIds = x.Roles.Select(r => r.RoleId).ToArray() }).ToArrayAsync(ct),
        roles = await db.Roles.AsNoTracking().OrderBy(x => x.Name).Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct),
        departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name)
            .Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct)
    });

    private static TargetsInput Audience(string json, IEnumerable<Guid> legacy) => string.IsNullOrEmpty(json)
        ? new TargetsInput(legacy.ToArray(), [], []) : JsonSerializer.Deserialize<TargetsInput>(json)!;

    // Resolve groups at save time into a deduplicated recipient snapshot; retain the selection for editing.
    private static async Task<Guid[]?> ResolveAudienceAsync(TargetsInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var users = input.UserIds; var roles = input.RoleIds ?? []; var departments = input.DepartmentIds ?? [];
        if (users is null || users.Length + roles.Length + departments.Length is < 1 or > 10000
            || await db.Users.CountAsync(x => users.Contains(x.Id) && x.IsEnabled, ct) != users.Distinct().Count()
            || await db.Roles.CountAsync(x => roles.Contains(x.Id), ct) != roles.Distinct().Count()
            || await db.Departments.CountAsync(x => departments.Contains(x.Id) && x.IsEnabled, ct) != departments.Distinct().Count()) return null;
        var ids = await db.Users.AsNoTracking().Where(x => x.IsEnabled && (users.Contains(x.Id)
            || departments.Contains(x.DepartmentId) || x.Roles.Any(r => roles.Contains(r.RoleId)))).Select(x => x.Id).ToArrayAsync(ct);
        return ids.Length is > 0 and <= 10000 ? ids : null;
    }

    private static string? AnnouncementError(AnnouncementInput input) =>
        string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 200 || string.IsNullOrWhiteSpace(input.Body)
        || input.Body.Length > 20000 ? "标题或正文长度无效"
        : input.EndsAt is { } end && end <= input.StartsAt ? "结束时间必须晚于发布时间" : null;

    private static async Task<IResult> ListAnnouncementsAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(
        (await db.DesktopAnnouncements.AsNoTracking().Include(x => x.Recipients).ThenInclude(x => x.User)
            .OrderByDescending(x => x.CreatedAt).ToArrayAsync(ct)).Select(x => new
        {
            x.Id, x.Title, x.Body, x.Important, x.Status, x.StartsAt, x.EndsAt, x.CreatedAt,
            audience = Audience(x.AudienceJson, x.Recipients.Select(r => r.UserId)),
            Recipients = x.Recipients.Select(r => new { r.UserId, r.User.Name, r.User.EmployeeNo, r.DeliveredAt, r.ReadAt, r.ConfirmedAt })
        }));

    private static async Task<IResult> CreateAnnouncementAsync(AnnouncementInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var error = AnnouncementError(input);
        if (error is not null) return Results.BadRequest(new { error });
        var audience = new TargetsInput(input.UserIds, input.RoleIds ?? [], input.DepartmentIds ?? []);
        var recipients = await ResolveAudienceAsync(audience, db, ct);
        if (recipients is null) return Results.BadRequest(new { error = "请选择有效的用户、角色或部门，范围内须有启用用户" });
        var item = new DesktopAnnouncement { Title = input.Title.Trim(), Body = input.Body.Trim(), Important = input.Important,
            StartsAt = input.StartsAt.ToUniversalTime(), EndsAt = input.EndsAt?.ToUniversalTime(),
            AudienceJson = JsonSerializer.Serialize(audience),
            Recipients = recipients.Select(id => new DesktopAnnouncementRecipient { UserId = id }).ToList() };
        db.DesktopAnnouncements.Add(item); await db.SaveChangesAsync(ct);
        return Results.Ok(new { item.Id });
    }

    private static async Task<IResult> EditAnnouncementAsync(Guid id, AnnouncementInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.DesktopAnnouncements.Include(x => x.Recipients).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (item is null) return Results.NotFound();
        if (item.Status != "Draft") return Results.Conflict(new { error = "已发布公告不可编辑，请撤回后新建公告" });
        var error = AnnouncementError(input);
        if (error is not null) return Results.BadRequest(new { error });
        var audience = new TargetsInput(input.UserIds, input.RoleIds ?? [], input.DepartmentIds ?? []);
        var recipients = await ResolveAudienceAsync(audience, db, ct);
        if (recipients is null) return Results.BadRequest(new { error = "请选择有效的用户、角色或部门，范围内须有启用用户" });
        item.AudienceJson = JsonSerializer.Serialize(audience);
        item.Title = input.Title.Trim(); item.Body = input.Body.Trim(); item.Important = input.Important;
        item.StartsAt = input.StartsAt.ToUniversalTime(); item.EndsAt = input.EndsAt?.ToUniversalTime();
        db.DesktopAnnouncementRecipients.RemoveRange(item.Recipients.Where(x => !recipients.Contains(x.UserId)));
        foreach (var userId in recipients.Where(userId => item.Recipients.All(x => x.UserId != userId)))
            item.Recipients.Add(new DesktopAnnouncementRecipient { UserId = userId });
        await db.SaveChangesAsync(ct); return Results.NoContent();
    }

    private static async Task<IResult> AnnouncementStatusAsync(Guid id, StatusInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.DesktopAnnouncements.Include(x => x.Recipients).SingleOrDefaultAsync(x => x.Id == id, ct);
        if (item is null) return Results.NotFound();
        if (!((item.Status == "Draft" && input.Status == "Published") || (item.Status == "Published" && input.Status == "Withdrawn")))
            return Results.BadRequest(new { error = "公告状态转换无效" });
        if (input.Status == "Published" && (item.Recipients.Count == 0 || item.EndsAt <= DateTimeOffset.UtcNow))
            return Results.BadRequest(new { error = "公告没有接收人员或已过期" });
        item.Status = input.Status; await db.SaveChangesAsync(ct); return Results.NoContent();
    }

    private static async Task<IResult> InboxAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var now = DateTimeOffset.UtcNow;
        var items = await db.DesktopAnnouncementRecipients.AsNoTracking().Where(x => x.UserId == user.Id
            && x.Announcement.Status == "Published" && x.Announcement.StartsAt <= now
            && (x.Announcement.EndsAt == null || x.Announcement.EndsAt > now))
            .OrderBy(x => x.ReadAt != null).ThenByDescending(x => x.Announcement.StartsAt).Take(100).Select(x => new
            { x.Announcement.Id, x.Announcement.Title, x.Announcement.Body, x.Announcement.Important,
                x.Announcement.StartsAt, x.DeliveredAt, x.ReadAt, x.ConfirmedAt }).ToArrayAsync(ct);
        return Results.Ok(new { items });
    }

    private static async Task<IResult> ReceiptAsync(Guid id, ReceiptInput input, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (input.Status is not ("Delivered" or "Read" or "Confirmed")) return Results.BadRequest();
        var now = DateTimeOffset.UtcNow;
        var recipient = await db.DesktopAnnouncementRecipients.SingleOrDefaultAsync(x => x.AnnouncementId == id && x.UserId == user.Id
            && x.Announcement.Status == "Published" && x.Announcement.StartsAt <= now
            && (x.Announcement.EndsAt == null || x.Announcement.EndsAt > now), ct);
        if (recipient is null) return Results.NotFound();
        recipient.DeliveredAt ??= now;
        if (input.Status != "Delivered") recipient.ReadAt ??= now;
        if (input.Status == "Confirmed") recipient.ConfirmedAt ??= now;
        await db.SaveChangesAsync(ct); return Results.NoContent();
    }

    private static async Task<IResult> ListReleasesAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(
        (await db.DesktopReleases.AsNoTracking().Include(x => x.Recipients).ThenInclude(x => x.User)
            .OrderByDescending(x => x.CreatedAt).ToArrayAsync(ct)).Select(x => new
        {
            x.Id, x.Version, x.Notes, x.Platform, x.Arch, x.Status, x.FileName, x.Bytes, x.HasBlockmap, x.CreatedAt,
            audience = Audience(x.AudienceJson, x.Recipients.Select(r => r.UserId)),
            Recipients = x.Recipients.Select(r => new { r.UserId, r.User.Name, r.User.EmployeeNo })
        }));

    private static async Task<IResult> ListClientsAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(
        await db.DesktopClientReports.AsNoTracking().OrderByDescending(x => x.LastSeenAt).Take(1000).Select(x => new
        { x.UserId, x.User.Name, x.User.EmployeeNo, x.DeviceId, x.ComputerName, x.Version, x.Platform, x.Arch,
            x.UpdateStatus, x.TargetVersion, x.Error, x.LastSeenAt }).ToArrayAsync(ct));

    private static async Task<IResult> CreateReleaseAsync(ReleaseInput input, AigcHubDbContext db, CancellationToken ct)
    {
        if (!DesktopVersion.Valid(input.Version) || input.Arch is not ("x64" or "arm64") || input.Notes is null || input.Notes.Length > 20000)
            return Results.BadRequest(new { error = "版本号必须是 SemVer，架构为 x64 或 arm64" });
        var audience = new TargetsInput(input.UserIds, input.RoleIds ?? [], input.DepartmentIds ?? []);
        var recipients = await ResolveAudienceAsync(audience, db, ct);
        if (recipients is null) return Results.BadRequest(new { error = "请选择有效的用户、角色或部门，范围内须有启用用户" });
        await ReleaseGate.WaitAsync(ct);
        try
        {
            if (await db.DesktopReleases.AnyAsync(x => x.Version == input.Version && x.Arch == input.Arch, ct))
                return Results.Conflict(new { error = "该版本和架构已存在" });
            var item = new DesktopRelease { Version = input.Version, Notes = input.Notes, Arch = input.Arch,
                AudienceJson = JsonSerializer.Serialize(audience),
                Recipients = recipients.Select(id => new DesktopReleaseRecipient { UserId = id }).ToList() };
            db.DesktopReleases.Add(item); await db.SaveChangesAsync(ct); return Results.Ok(new { item.Id });
        }
        finally { ReleaseGate.Release(); }
    }

    private static async Task<IResult> ReleaseTargetsAsync(Guid id, TargetsInput input, AigcHubDbContext db, CancellationToken ct)
    {
        var audience = input with { RoleIds = input.RoleIds ?? [], DepartmentIds = input.DepartmentIds ?? [] };
        var recipients = await ResolveAudienceAsync(audience, db, ct);
        if (recipients is null) return Results.BadRequest(new { error = "请选择有效的用户、角色或部门，范围内须有启用用户" });
        await ReleaseGate.WaitAsync(ct);
        try
        {
            var item = await db.DesktopReleases.Include(x => x.Recipients).SingleOrDefaultAsync(x => x.Id == id, ct);
            if (item is null) return Results.NotFound();
            item.AudienceJson = JsonSerializer.Serialize(audience);
            db.DesktopReleaseRecipients.RemoveRange(item.Recipients.Where(x => !recipients.Contains(x.UserId)));
            foreach (var userId in recipients.Where(userId => item.Recipients.All(x => x.UserId != userId)))
                item.Recipients.Add(new DesktopReleaseRecipient { UserId = userId });
            await db.SaveChangesAsync(ct); return Results.NoContent();
        }
        finally { ReleaseGate.Release(); }
    }

    private static async Task<IResult> ReleaseStatusAsync(Guid id, StatusInput input, AigcHubDbContext db, CancellationToken ct)
    {
        await ReleaseGate.WaitAsync(ct);
        try
        {
            var item = await db.DesktopReleases.SingleOrDefaultAsync(x => x.Id == id, ct);
            if (item is null) return Results.NotFound();
            if (!((item.Status is "Draft" or "Paused" && input.Status == "Published") || (item.Status == "Published" && input.Status == "Paused")))
                return Results.BadRequest(new { error = "发布状态转换无效" });
            if (input.Status == "Published" && item.Bytes == 0) return Results.BadRequest(new { error = "请先上传安装包" });
            item.Status = input.Status; await db.SaveChangesAsync(ct); return Results.NoContent();
        }
        finally { ReleaseGate.Release(); }
    }

    private static string Root(IConfiguration config, IWebHostEnvironment env) =>
        Path.GetFullPath(config["DesktopReleases:Root"] ?? Path.Combine(env.ContentRootPath, "data", "desktop-releases"));

    private static async Task<IResult> UploadAsync(Guid id, HttpRequest request, IConfiguration config, IWebHostEnvironment env,
        AigcHubDbContext db, CancellationToken ct)
    {
        if (!request.HasFormContentType) return Results.BadRequest(new { error = "请上传 multipart 文件" });
        await ReleaseGate.WaitAsync(ct);
        string? staging = null;
        try
        {
            var item = await db.DesktopReleases.SingleOrDefaultAsync(x => x.Id == id, ct);
            if (item is null) return Results.NotFound();
            if (item.Status != "Draft" || item.Bytes > 0) return Results.Conflict(new { error = "更新文件不可覆盖，请创建新版本" });
            var form = await request.ReadFormAsync(ct);
            var installer = form.Files.GetFile("installer"); var blockmap = form.Files.GetFile("blockmap");
            if (installer is null || installer.Length is < 1 or > MaximumPackageBytes
                || !Regex.IsMatch(installer.FileName, @"^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,170}\.exe$", RegexOptions.IgnoreCase)
                || (blockmap is not null && (blockmap.FileName != installer.FileName + ".blockmap" || blockmap.Length is < 1 or > 32 * 1024 * 1024)))
                return Results.BadRequest(new { error = "上传有效的 Windows .exe 安装包及对应 .exe.blockmap 文件" });
            var directory = Path.Combine(Root(config, env), id.ToString("N"));
            staging = directory + "." + Guid.NewGuid().ToString("N") + ".tmp";
            Directory.CreateDirectory(staging);
            var file = Path.Combine(staging, "installer.exe");
            await using (var stream = File.Create(file)) await installer.CopyToAsync(stream, ct);
            await using (var stream = File.OpenRead(file)) item.Sha512 = Convert.ToBase64String(await SHA512.HashDataAsync(stream, ct));
            if (blockmap is not null)
                await using (var stream = File.Create(Path.Combine(staging, "installer.exe.blockmap"))) await blockmap.CopyToAsync(stream, ct);
            // An interrupted draft upload owns no published artifact and may be retried.
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
            Directory.Move(staging, directory); staging = null;
            item.FileName = installer.FileName; item.Bytes = installer.Length; item.HasBlockmap = blockmap is not null;
            await db.SaveChangesAsync(ct); return Results.NoContent();
        }
        finally
        {
            if (staging is not null && Directory.Exists(staging)) Directory.Delete(staging, true);
            ReleaseGate.Release();
        }
    }

    private static async Task<IResult> CheckAsync(ClientInput input, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        if (string.IsNullOrWhiteSpace(input.DeviceId) || input.DeviceId.Length > 128 || input.ComputerName is null
            || input.ComputerName.Length > 200 || !DesktopVersion.Valid(input.Version) || input.Platform != "win32"
            || input.Arch is not ("x64" or "arm64") || input.UpdateStatus is not ("Current" or "Available" or "Downloading" or "Ready" or "Installing" or "Failed")
            || input.TargetVersion is null || (input.TargetVersion != "" && !DesktopVersion.Valid(input.TargetVersion)) || input.Error is null || input.Error.Length > 2000)
            return Results.BadRequest(new { error = "客户端上报参数无效" });
        await ReportGate.WaitAsync(ct);
        try
        {
        var report = await db.DesktopClientReports.FindAsync([user.Id, input.DeviceId], ct);
        if (report is null) { report = new DesktopClientReport { UserId = user.Id, DeviceId = input.DeviceId }; db.DesktopClientReports.Add(report); }
        report.ComputerName = input.ComputerName; report.Version = input.Version; report.Platform = input.Platform; report.Arch = input.Arch;
        report.UpdateStatus = input.UpdateStatus; report.TargetVersion = input.TargetVersion; report.Error = input.Error; report.LastSeenAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        }
        finally { ReportGate.Release(); }
        var candidates = await db.DesktopReleases.AsNoTracking().Where(x => x.Status == "Published" && x.Bytes > 0
            && x.Platform == input.Platform && x.Arch == input.Arch && x.Recipients.Any(r => r.UserId == user.Id)).ToListAsync(ct);
        var release = candidates.Where(x => DesktopVersion.Compare(x.Version, input.Version) > 0)
            .OrderByDescending(x => x.Version, Comparer<string>.Create(DesktopVersion.Compare)).FirstOrDefault();
        return Results.Ok(new { release = release is null ? null : new { release.Id, release.Version, release.Notes,
            feedPath = $"/v1/desktop/updates/{release.Id}/" } });
    }

    private static async Task<IResult> DownloadAsync(Guid id, string file, HttpRequest request, IConfiguration config,
        IWebHostEnvironment env, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var item = await db.DesktopReleases.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.Status == "Published"
            && x.Bytes > 0 && x.Recipients.Any(r => r.UserId == user.Id), ct);
        if (item is null) return Results.NotFound();
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        if (file is "nightly.yml" or "latest.yml" or "alpha.yml" or "beta.yml")
        {
            var name = JsonSerializer.Serialize(item.FileName);
            var yaml = $"version: {item.Version}\nfiles:\n  - url: {name}\n    sha512: {item.Sha512}\n    size: {item.Bytes}\npath: {name}\nsha512: {item.Sha512}\nreleaseNotes: {JsonSerializer.Serialize(item.Notes)}\n";
            return Results.Text(yaml, "text/yaml");
        }
        var stored = file == item.FileName ? "installer.exe"
            : item.HasBlockmap && file == item.FileName + ".blockmap" ? "installer.exe.blockmap" : null;
        if (stored is null) return Results.NotFound();
        var path = Path.Combine(Root(config, env), id.ToString("N"), stored);
        return File.Exists(path) ? Results.File(path, "application/octet-stream", enableRangeProcessing: true) : Results.NotFound();
    }
}
