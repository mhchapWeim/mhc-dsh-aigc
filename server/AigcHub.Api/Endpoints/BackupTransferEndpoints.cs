using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class BackupTransferEndpoints
{
    internal static readonly SemaphoreSlim Mutation = new(1);
    public sealed record StartInput(long Bytes, string Sha256, string Scope, JsonElement Manifest);
    public sealed record Storage(string StorageKind, string Key, string UploadId, string State, int PartBytes, string Scope, JsonElement Manifest);
    public static Storage? Descriptor(DshBackup row)
    {
        using var json = JsonDocument.Parse(row.Payload);
        if (!json.RootElement.TryGetProperty("StorageKind", out var kind) || kind.GetString() is not ("minio-v1" or "minio-v2")) return null;
        return JsonSerializer.Deserialize<Storage>(row.Payload);
    }
    private static BackupStorageOptions Options(IOptions<BackupStorageOptions> configured)
    {
        var options = configured.Value;
        if (!options.Enabled) throw new WorkflowException("MinIO 备份存储尚未启用", 503);
        if (options.PartBytes < 5 * 1024 * 1024 || options.PartBytes > 16 * 1024 * 1024
            || options.MaximumBytes < 1 || options.MaximumBytes > options.PartBytes * 10000L
            || options.AccountQuotaBytes < options.MaximumBytes || options.UploadLifetimeHours < 1)
            throw new WorkflowException("备份容量或分片配置无效", 503);
        return options;
    }
    public static int Validate(StartInput input, BackupStorageOptions options)
    {
        if (input.Bytes < 1 || input.Bytes > options.MaximumBytes || input.Scope is not ("all" or "selected")
            || !Regex.IsMatch(input.Sha256 ?? "", "^[a-f0-9]{64}$")) throw new WorkflowException("备份超过容量上限或参数无效", 400);
        try {
            var manifest = input.Manifest;
            if (manifest.GetProperty("version").GetInt32() != 2) throw new FormatException();
            var sessions = manifest.GetProperty("sessions");
            if (sessions.GetArrayLength() is < 1 or > 10000) throw new FormatException();
            var ids = new HashSet<string>();
            var files = new HashSet<string>();
            foreach (var session in sessions.EnumerateArray()) {
                var id = session.GetProperty("id").GetString();
                if (string.IsNullOrEmpty(id) || id.Length > 256 || !ids.Add(id)
                    || session.GetProperty("title").GetString() is not { Length: <= 512 }) throw new FormatException();
                CheckFile(session, "sessions/", ".json", files);
            }
            if (manifest.GetProperty("objects").GetArrayLength() > 10000) throw new FormatException();
            foreach (var item in manifest.GetProperty("objects").EnumerateArray()) CheckFile(item, "objects/", ".bin", files);
            if (files.Count > 20000 || sessions.EnumerateArray().Concat(manifest.GetProperty("objects").EnumerateArray())
                .Sum(item => item.GetProperty("bytes").GetInt64()) > options.MaximumBytes) throw new FormatException();
            return sessions.GetArrayLength();
        } catch (Exception e) when (e is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException) {
            throw new WorkflowException("备份清单无效", 400);
        }
    }
    private static void CheckFile(JsonElement item, string prefix, string suffix, HashSet<string> files)
    {
        var path = item.GetProperty("file").GetString() ?? "";
        if (!Regex.IsMatch(path, "^" + prefix + "[a-f0-9]{64}" + Regex.Escape(suffix) + "$") || !files.Add(path)
            || item.GetProperty("bytes").GetInt64() < 0 || !Regex.IsMatch(item.GetProperty("sha256").GetString() ?? "", "^[a-f0-9]{64}$")) throw new FormatException();
    }

    public static void MapBackupTransferEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/v1/backup-transfers").WithTags("MinIO 会话备份");
        group.MapGet("/limits", async (HttpRequest request, AigcHubDbContext db, IOptions<BackupStorageOptions> configured, CancellationToken ct) => {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            if (user is null) return Results.Unauthorized();
            var options = Options(configured);
            return Results.Ok(new { userId = user.Id, maximumBytes = options.MaximumBytes, partBytes = options.PartBytes,
                quotaBytes = options.AccountQuotaBytes, usedBytes = await db.DshBackups.Where(x => x.UserId == user.Id).SumAsync(x => x.Bytes, ct),
                uploadLifetimeHours = options.UploadLifetimeHours });
        });
        group.MapPost("/", StartAsync).WithMetadata(new RequestSizeLimitAttribute(2 * 1024 * 1024));
        group.MapGet("/{id:guid}", StatusAsync);
        group.MapPut("/{id:guid}/parts/{number:int}", PartAsync).WithMetadata(new RequestSizeLimitAttribute(16 * 1024 * 1024));
        group.MapPost("/{id:guid}/complete", CompleteAsync);
        group.MapGet("/{id:guid}/download", DownloadAsync);
        group.MapDelete("/{id:guid}", DeleteAsync);
    }

    private static async Task<IResult> StartAsync(StartInput input, HttpRequest request, AigcHubDbContext db,
        IOptions<BackupStorageOptions> configured, IBackupObjectStore store, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var options = Options(configured);
        var count = Validate(input, options);
        await Mutation.WaitAsync(ct);
        try {
            var used = await db.DshBackups.Where(x => x.UserId == user.Id).SumAsync(x => x.Bytes, ct);
            if (used > options.AccountQuotaBytes - input.Bytes) return Results.Problem("账号备份空间不足", statusCode: 409);
            var row = new DshBackup { UserId = user.Id, Bytes = input.Bytes, Sha256 = input.Sha256,
                SessionCount = count, Scope = "pending:" + input.Scope };
            var key = $"accounts/{user.Id:D}/{row.Id:D}.tar.gz";
            var uploadId = await store.StartAsync(key, ct);
            row.Payload = JsonSerializer.Serialize(new Storage("minio-v2", key, uploadId, "uploading", options.PartBytes, input.Scope, input.Manifest));
            db.DshBackups.Add(row);
            try { await db.SaveChangesAsync(ct); }
            catch { await store.DeleteAsync(key, uploadId, CancellationToken.None); throw; }
            return Results.Ok(new { id = row.Id, partBytes = options.PartBytes });
        } finally { Mutation.Release(); }
    }

    private static async Task<DshBackup?> Owned(HttpRequest request, Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return null;
        return await db.DshBackups.SingleOrDefaultAsync(x => x.Id == id && x.UserId == user.Id, ct);
    }

    private static async Task<IResult> StatusAsync(Guid id, HttpRequest request, AigcHubDbContext db,
        IBackupObjectStore store, IOptions<BackupStorageOptions> configured, CancellationToken ct)
    {
        var row = await Owned(request, id, db, ct);
        if (row is null) return Results.NotFound();
        var storage = Descriptor(row);
        if (storage is null || storage.StorageKind == "minio-v1") return Results.Ok(new { id = row.Id, state = "legacy", row.Bytes, row.Sha256 });
        if (storage.State != "complete" && row.CreatedAt.AddHours(Options(configured).UploadLifetimeHours) < DateTimeOffset.UtcNow) return Results.StatusCode(410);
        var parts = storage.State == "uploading" ? await store.PartsAsync(storage.Key, storage.UploadId, ct) : [];
        return Results.Ok(new { id = row.Id, state = storage.State, row.Bytes, row.Sha256,
            partBytes = storage.PartBytes, manifest = storage.Manifest, parts });
    }

    private static async Task<IResult> PartAsync(Guid id, int number, HttpRequest request, AigcHubDbContext db,
        IOptions<BackupStorageOptions> configured, IBackupObjectStore store, CancellationToken ct)
    {
        var row = await Owned(request, id, db, ct);
        if (row is null) return Results.NotFound();
        var storage = Descriptor(row);
        if (storage is null || storage.State != "uploading") return Results.Conflict();
        if (row.CreatedAt.AddHours(Options(configured).UploadLifetimeHours) < DateTimeOffset.UtcNow) return Results.StatusCode(410);
        var parts = (row.Bytes + storage.PartBytes - 1) / storage.PartBytes;
        var bytes = number == parts ? row.Bytes - (number - 1L) * storage.PartBytes : storage.PartBytes;
        if (number < 1 || number > parts || request.ContentLength != bytes) return Results.BadRequest();
        await store.PutAsync(storage.Key, storage.UploadId, number, request.Body, bytes, ct);
        return Results.NoContent();
    }

    private static async Task<IResult> CompleteAsync(Guid id, HttpRequest request, AigcHubDbContext db,
        IBackupObjectStore store, CancellationToken ct)
    {
        var row = await Owned(request, id, db, ct);
        if (row is null) return Results.NotFound();
        await Mutation.WaitAsync(ct);
        try {
            await db.Entry(row).ReloadAsync(ct);
            var storage = Descriptor(row);
            if (storage is null) return Results.Conflict();
            if (storage.State == "complete") return Results.Ok(View(row));
            if (storage.State == "completing") {
                try {
                    var remaining = await store.PartsAsync(storage.Key, storage.UploadId, ct);
                    await store.CompleteAsync(storage.Key, storage.UploadId, remaining, ct);
                } catch (Amazon.S3.AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchUpload") { /* Completion already committed to MinIO. */ }
            }
            if (storage.State == "uploading") {
                var parts = await store.PartsAsync(storage.Key, storage.UploadId, ct);
                var expected = (row.Bytes + storage.PartBytes - 1) / storage.PartBytes;
                if (parts.Count != expected || parts.OrderBy(p => p.Number).Where((p, i) => p.Number != i + 1
                    || p.Bytes != (p.Number == expected ? row.Bytes - (expected - 1) * storage.PartBytes : storage.PartBytes)).Any()) return Results.Conflict();
                // Persist before S3 completion: a retry can discover whether completion already succeeded.
                storage = storage with { State = "completing" };
                row.Payload = JsonSerializer.Serialize(storage);
                await db.SaveChangesAsync(ct);
                await store.CompleteAsync(storage.Key, storage.UploadId, parts, ct);
            }
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long length = 0;
            await store.ReadAsync(storage.Key, null, null, async stream => {
                var buffer = new byte[128 * 1024];
                int read;
                while ((read = await stream.ReadAsync(buffer, ct)) > 0) { hash.AppendData(buffer, 0, read); length += read; }
            }, ct);
            if (length != row.Bytes || Convert.ToHexStringLower(hash.GetHashAndReset()) != row.Sha256)
                return Results.Problem("备份完整性校验失败", statusCode: 422);
            row.Payload = JsonSerializer.Serialize(storage with { State = "complete" });
            row.Scope = storage.Scope;
            await db.SaveChangesAsync(ct);
            return Results.Ok(View(row));
        } finally { Mutation.Release(); }
    }

    private static object View(DshBackup row) => new { row.Id, row.CreatedAt, row.Bytes, row.SessionCount, row.Scope, row.Sha256 };

    private static async Task<IResult> DownloadAsync(Guid id, HttpRequest request, AigcHubDbContext db,
        IBackupObjectStore store, CancellationToken ct)
    {
        var row = await Owned(request, id, db, ct);
        if (row is null) return Results.NotFound();
        var storage = Descriptor(row);
        if (storage?.State != "complete") return Results.Conflict();
        long start = 0, end = row.Bytes - 1;
        var range = request.Headers.Range.ToString();
        if (range != "") {
            var match = Regex.Match(range, "^bytes=([0-9]+)-([0-9]+)$");
            if (!match.Success || !long.TryParse(match.Groups[1].Value, out start) || !long.TryParse(match.Groups[2].Value, out end)
                || start > end || end >= row.Bytes) return Results.StatusCode(416);
        }
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        request.HttpContext.Response.Headers.AcceptRanges = "bytes";
        request.HttpContext.Response.ContentLength = end - start + 1;
        if (range != "") {
            request.HttpContext.Response.StatusCode = 206;
            request.HttpContext.Response.Headers.ContentRange = $"bytes {start}-{end}/{row.Bytes}";
        }
        return Results.Stream(output => store.ReadAsync(storage.Key, start, end, stream => stream.CopyToAsync(output, ct), ct), "application/gzip");
    }

    private static async Task<IResult> DeleteAsync(Guid id, HttpRequest request, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct)
    {
        await Mutation.WaitAsync(ct);
        try {
        var row = await Owned(request, id, db, ct);
        if (row is null) return Results.NotFound();
        var storage = Descriptor(row);
        if (storage is null) return Results.Conflict();
        await store.DeleteAsync(storage.Key, storage.State == "complete" ? null : storage.UploadId, ct);
        db.DshBackups.Remove(row); await db.SaveChangesAsync(ct);
        return Results.NoContent();
        } finally { Mutation.Release(); }
    }
}
