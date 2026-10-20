using System.Security.Cryptography;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc;

namespace AigcHub.Api.Endpoints;

public static class PluginMarketEndpoints
{
    public const string SearchPackage = "@bhss/dsh-plugin-managed-search";
    public static string Resource(Guid id) => $"plugin:{id:D}";
    public static string SecretPurpose(Guid id) => $"AigcHub.Plugin.{id:D}.v1";
    private sealed record PolicyInput(string Name, bool IsEnabled, Guid? VersionId, JsonElement Configuration, AccessGrantSelection Grants, string? ServerSecret);
    private sealed record ReportInput(string DeviceId, Guid PluginId, string Version, long Revision, string Status, string? Error);

    public static void MapPluginMarketEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/plugins").WithTags("插件市场").RequireAuthorization("plugin.manage");
        admin.MapGet("/", ListAsync);
        admin.MapGet("/grant-options", OptionsAsync);
        admin.MapGet("/reports", ReportsAsync);
        admin.MapPost("/upload", UploadAsync).DisableAntiforgery()
            .WithMetadata(new RequestSizeLimitAttribute(PluginPackageReader.MaximumBytes + 1024 * 1024));
        admin.MapPut("/{id:guid}/policy", SaveAsync);
        var client = app.MapGroup("/v1/plugins").WithTags("DSH 插件同步");
        client.MapGet("/policy", PolicyAsync);
        client.MapGet("/{id:guid}/versions/{versionId:guid}/package", DownloadAsync);
        client.MapPost("/reports", ReportAsync);
        client.MapPost("/search", BochaSearchService.SearchAsync);
    }

    private static string Root(IConfiguration config, IWebHostEnvironment env) =>
        Path.GetFullPath(config["Plugins:StoragePath"] ?? Path.Combine(env.ContentRootPath, "App_Data", "plugins"));

    private static async Task<IResult> ListAsync(AigcHubDbContext db, AccessGrantService grants, CancellationToken ct)
    {
        var result = new List<object>();
        foreach (var plugin in await db.ManagedPlugins.AsNoTracking().Include(x => x.Versions).OrderBy(x => x.Name).ToListAsync(ct))
            result.Add(new { plugin.Id, plugin.PackageName, plugin.Name, plugin.Description, plugin.IsEnabled,
                plugin.PublishedVersionId, plugin.Revision, configuration = JsonSerializer.Deserialize<JsonElement>(plugin.ConfigurationJson),
                hasServerSecret = plugin.ServerSecretProtected.Length > 0, grants = await grants.GetAsync(Resource(plugin.Id), ct),
                versions = plugin.Versions.OrderByDescending(x => x.CreatedAt).Select(x => new { x.Id, x.Version, x.DshVersion, x.Sha256, x.Size, x.CreatedAt }) });
        return Results.Ok(result);
    }

    private static async Task<IResult> OptionsAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(new {
        users = await db.Users.AsNoTracking().Where(x => x.IsEnabled).Select(x => new { x.Id, x.Name, x.EmployeeNo }).ToArrayAsync(ct),
        roles = await db.Roles.AsNoTracking().Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct),
        departments = await db.Departments.AsNoTracking().Where(x => x.IsEnabled).Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct)
    });

    private static async Task<IResult> ReportsAsync(AigcHubDbContext db, int? page, int? pageSize, CancellationToken ct)
    {
        var size = Math.Clamp(pageSize ?? 5, 1, 100);
        var query = db.ManagedPluginReports.AsNoTracking();
        var total = await query.CountAsync(ct);
        var number = Math.Clamp(page ?? 1, 1, Math.Max(1, (int)Math.Ceiling((double)total / size)));
        var items = await query.OrderByDescending(x => x.UpdatedAt).ThenBy(x => x.UserId)
            .ThenBy(x => x.DeviceId).ThenBy(x => x.PluginId)
            .Skip((number - 1) * size).Take(size).ToArrayAsync(ct);
        return Results.Ok(new { items, total, page = number, pageSize = size });
    }

    private static async Task<IResult> UploadAsync(HttpRequest request, AigcHubDbContext db, IConfiguration config,
        IWebHostEnvironment env, ICurrentUser current, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        if (!request.HasFormContentType) return Results.BadRequest("请上传 .tgz 插件包");
        var file = (await request.ReadFormAsync(ct)).Files.GetFile("package");
        if (file is null || file.Length is < 1 or > PluginPackageReader.MaximumBytes) return Results.BadRequest("插件包须为 1 字节至 32 MB");
        using var bytes = new MemoryStream();
        await file.CopyToAsync(bytes, ct); bytes.Position = 0;
        PluginPackageMetadata metadata;
        try { metadata = PluginPackageReader.Read(bytes); }
        catch (Exception error) when (error is JsonException or InvalidDataException or KeyNotFoundException or InvalidOperationException or ArgumentException)
        {
            loggerFactory.CreateLogger("PluginPackageUpload").LogWarning(error,
                "Plugin package validation failed. Size={Size}, Sha256={Sha256}, TraceId={TraceId}",
                bytes.Length, Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant(), request.HttpContext.TraceIdentifier);
            if (error is ObjectDisposedException)
                return Results.Problem("服务端读取插件包失败，请更新后端后重试", statusCode: 500);
            var detail = error switch
            {
                JsonException => "package.json 不是有效的 JSON",
                KeyNotFoundException => "package.json 缺少 name、version、main、dsh.bundle.patch 或 aigc.dshVersion",
                InvalidDataException => "gzip/tar 数据无效或压缩包不完整",
                _ => "package.json 字段类型或值无效"
            };
            return Results.BadRequest($"插件包格式无效：{detail}（诊断编号：{request.HttpContext.TraceIdentifier}）");
        }
        var plugin = await db.ManagedPlugins.SingleOrDefaultAsync(x => x.PackageName == metadata.PackageName, ct);
        if (plugin is null) { plugin = new ManagedPlugin { PackageName = metadata.PackageName, Name = metadata.PackageName, Description = metadata.Description }; db.ManagedPlugins.Add(plugin); }
        if (await db.ManagedPluginVersions.AnyAsync(x => x.PluginId == plugin.Id && x.Version == metadata.Version, ct))
            return Results.Conflict("此版本已存在；请增加版本号");
        var version = new ManagedPluginVersion { PluginId = plugin.Id, Version = metadata.Version, DshVersion = metadata.DshVersion,
            ManifestJson = metadata.ManifestJson, Size = bytes.Length, Sha256 = Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant() };
        Directory.CreateDirectory(Root(config, env));
        var path = Path.Combine(Root(config, env), $"{version.Id:N}.tgz");
        await File.WriteAllBytesAsync(path, bytes.ToArray(), ct);
        db.ManagedPluginVersions.Add(version);
        db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "plugin.upload", EntityType = "Plugin", EntityId = plugin.Id.ToString(), Succeeded = true,
            DetailJson = JsonSerializer.Serialize(new { metadata.PackageName, metadata.Version, version.Sha256 }) });
        try { await db.SaveChangesAsync(ct); }
        catch { File.Delete(path); throw; }
        return Results.Ok(new { pluginId = plugin.Id, versionId = version.Id, metadata.Version });
    }
    private static async Task<IResult> SaveAsync(Guid id, PolicyInput input, AigcHubDbContext db, AccessGrantService grants,
        IDataProtectionProvider protection, ICurrentUser current, CancellationToken ct)
    {
        var plugin = await db.ManagedPlugins.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (plugin is null) return Results.NotFound();
        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 120 || input.Configuration.ValueKind != JsonValueKind.Object
            || input.Configuration.GetRawText().Length > 64 * 1024) return Results.BadRequest("名称或 JSON 配置无效");
        if (input.VersionId is { } version && !await db.ManagedPluginVersions.AnyAsync(x => x.Id == version && x.PluginId == id, ct))
            return Results.BadRequest("版本不属于当前插件");
        if (input.IsEnabled && input.VersionId is null) return Results.BadRequest("启用前请选择发布版本");
        if (input.ServerSecret?.Length > 8192) return Results.BadRequest("密钥过长");
        if (plugin.PackageName == SearchPackage && input.IsEnabled && string.IsNullOrWhiteSpace(input.ServerSecret) && plugin.ServerSecretProtected.Length == 0)
            return Results.BadRequest("启用博查搜索前请配置服务端 API Key");
        if (input.Configuration.EnumerateObject().Any(x => x.Value.ValueKind != JsonValueKind.Object))
            return Results.BadRequest("配置必须为插件行 ID 到配置对象的映射");
        await grants.SetAsync(Resource(id), input.Grants, ct);
        plugin.Name = input.Name.Trim(); plugin.IsEnabled = input.IsEnabled; plugin.PublishedVersionId = input.VersionId;
        plugin.ConfigurationJson = input.Configuration.GetRawText(); plugin.Revision++;
        if (!string.IsNullOrWhiteSpace(input.ServerSecret))
            plugin.ServerSecretProtected = protection.CreateProtector(SecretPurpose(id)).Protect(input.ServerSecret.Trim());
        db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "plugin.publish", EntityType = "Plugin", EntityId = id.ToString(), Succeeded = true,
            DetailJson = JsonSerializer.Serialize(new { input.IsEnabled, input.VersionId, plugin.Revision }) });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> PolicyAsync(HttpRequest request, AigcHubDbContext db, AccessGrantService grants, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var result = new List<object>();
        foreach (var plugin in await db.ManagedPlugins.AsNoTracking().Include(x => x.Versions).ToListAsync(ct))
        {
            var enabled = plugin.IsEnabled && await grants.AllowsAsync(Resource(plugin.Id), user.Id, ct);
            var version = plugin.Versions.SingleOrDefault(x => x.Id == plugin.PublishedVersionId);
            result.Add(new { plugin.Id, plugin.PackageName, plugin.Revision, enabled = enabled && version is not null,
                version = enabled ? version?.Version : null, dshVersion = enabled ? version?.DshVersion : null,
                sha256 = enabled ? version?.Sha256 : null, size = enabled ? version?.Size : null,
                downloadPath = enabled && version is not null ? $"/v1/plugins/{plugin.Id:D}/versions/{version.Id:D}/package" : null,
                configuration = enabled ? JsonSerializer.Deserialize<JsonElement>(plugin.ConfigurationJson) : JsonSerializer.SerializeToElement(new { }) });
        }
        return Results.Ok(new { userId = user.Id, plugins = result });
    }

    private static async Task<IResult> DownloadAsync(Guid id, Guid versionId, HttpRequest request, AigcHubDbContext db,
        AccessGrantService grants, IConfiguration config, IWebHostEnvironment env, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var plugin = await db.ManagedPlugins.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (plugin is null || !plugin.IsEnabled || plugin.PublishedVersionId != versionId || !await grants.AllowsAsync(Resource(id), user.Id, ct))
            return Results.StatusCode(403);
        var path = Path.Combine(Root(config, env), $"{versionId:N}.tgz");
        return File.Exists(path) ? Results.File(path, "application/gzip", $"{versionId:N}.tgz", enableRangeProcessing: true) : Results.NotFound();
    }

    private static async Task<IResult> ReportAsync(ReportInput input, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (string.IsNullOrWhiteSpace(input.DeviceId) || input.DeviceId.Length > 128 || input.Version.Length > 100 || input.Error?.Length > 2000
            || !new[] { "Active", "Disabled", "RestartRequired", "Incompatible", "Failed" }.Contains(input.Status)
            || !await db.ManagedPlugins.AnyAsync(x => x.Id == input.PluginId, ct)) return Results.BadRequest("无效的插件状态");
        var report = await db.ManagedPluginReports.SingleOrDefaultAsync(x => x.UserId == user.Id && x.DeviceId == input.DeviceId && x.PluginId == input.PluginId, ct);
        if (report is null) { report = new ManagedPluginReport { UserId = user.Id, DeviceId = input.DeviceId, PluginId = input.PluginId }; db.ManagedPluginReports.Add(report); }
        report.Version = input.Version; report.Revision = input.Revision; report.Status = input.Status; report.Error = input.Error ?? ""; report.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
