using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class DshBackupEndpoints
{
    public const int MaxBytes = 24 * 1024 * 1024;
    public sealed record Input(string Payload, string Sha256, string Scope);

    public static void MapDshBackupEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapBackupTransferEndpoints();
        var client = app.MapGroup("/v1/backups").WithTags("客户端云端备份");
        client.MapPost("/", UploadAsync).WithMetadata(new RequestSizeLimitAttribute(MaxBytes * 2L));
        client.MapGet("/", async (int? page, int? pageSize, HttpRequest request, AigcHubDbContext db, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            return user is null ? Results.Unauthorized() : await ListAsync(user.Id, false, page ?? 1, pageSize ?? 20, "", db, ct);
        });
        client.MapGet("/{id:guid}", async (Guid id, HttpRequest request, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            return user is null ? Results.Unauthorized() : await DownloadAsync(id, user.Id, db, store, ct);
        });
        client.MapDelete("/{id:guid}", async (Guid id, HttpRequest request, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            return user is null ? Results.Unauthorized() : await DeleteAsync(id, user.Id, false, db, store, ct);
        });
        var portal = app.MapGroup("/api/dsh-backups").RequireAuthorization().WithTags("客户端备份管理");
        portal.MapGet("/", (int? page, int? pageSize, string? search, HttpContext http, ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
            ListAsync(current.Id, CanManage(http), page ?? 1, pageSize ?? 5, search ?? "", db, ct));
        portal.MapGet("/{id:guid}", async (Guid id, HttpContext http, ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        {
            var all = CanManage(http);
            var userId = current.Id;
            var row = await db.DshBackups.AsNoTracking().Where(x => x.Id == id && (x.UserId == userId || all))
                .Select(x => new { x.Id, x.UserId, x.User.Name, x.User.EmployeeNo, x.User.LastLoginAt, x.CreatedAt, x.Bytes, x.SessionCount, x.Scope, x.Sha256 }).SingleOrDefaultAsync(ct);
            return row is null ? Results.NotFound() : Results.Ok(row);
        });
        portal.MapGet("/{id:guid}/download", (Guid id, ICurrentUser current, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct) => DownloadAsync(id, current.Id, db, store, ct));
        portal.MapDelete("/{id:guid}", (Guid id, HttpContext http, ICurrentUser current, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct) =>
            DeleteAsync(id, current.Id, CanManage(http), db, store, ct));
    }

    private static bool CanManage(HttpContext http) => http.User.IsInRole("平台管理员");

    private static async Task<IResult> UploadAsync(Input input, HttpRequest request, AigcHubDbContext db, IBackupObjectStore store,
        IOptions<BackupStorageOptions> configured, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (input.Payload is null || input.Sha256 is null || input.Scope is not ("all" or "selected")) return Results.BadRequest();
        var bytes = Encoding.UTF8.GetBytes(input.Payload);
        if (bytes.Length > MaxBytes) return Results.StatusCode(413);
        var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (!hash.Equals(input.Sha256, StringComparison.OrdinalIgnoreCase)) return Results.BadRequest(new { message = "备份校验失败" });
        int count;
        try
        {
            using var json = JsonDocument.Parse(input.Payload);
            if (json.RootElement.GetProperty("version").GetInt32() != 1) return Results.BadRequest();
            count = json.RootElement.GetProperty("sessions").GetArrayLength();
            if (count < 1) return Results.BadRequest();
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        { return Results.BadRequest(new { message = "无效的会话备份格式" }); }
        if (!configured.Value.Enabled) return Results.Problem("MinIO 备份存储尚未启用", statusCode: 503);
        var row = new DshBackup { UserId = user.Id, Sha256 = hash, Bytes = bytes.Length, SessionCount = count, Scope = input.Scope };
        await BackupTransferEndpoints.Mutation.WaitAsync(ct);
        try {
            if (await db.DshBackups.Where(x => x.UserId == user.Id).SumAsync(x => x.Bytes, ct) > configured.Value.AccountQuotaBytes - bytes.Length)
                return Results.Problem("账号备份空间不足", statusCode: 409);
            var key = $"accounts/{user.Id:D}/{row.Id:D}.json";
            var uploadId = await store.StartAsync(key, ct);
            try {
                using var stream = new MemoryStream(bytes, false);
                await store.PutAsync(key, uploadId, 1, stream, bytes.Length, ct);
                await store.CompleteAsync(key, uploadId, await store.PartsAsync(key, uploadId, ct), ct);
                row.Payload = JsonSerializer.Serialize(new BackupTransferEndpoints.Storage("minio-v1", key, uploadId, "complete", MaxBytes, input.Scope, JsonSerializer.SerializeToElement(new { version = 1 })));
                db.DshBackups.Add(row);
                await db.SaveChangesAsync(ct);
            } catch { await store.DeleteAsync(key, uploadId, CancellationToken.None); throw; }
        } finally { BackupTransferEndpoints.Mutation.Release(); }
        return Results.Ok(new { row.Id, row.CreatedAt, row.Bytes, row.SessionCount, row.Scope, row.Sha256 });
    }

    private static async Task<IResult> ListAsync(Guid userId, bool all, int page, int pageSize, string search, AigcHubDbContext db, CancellationToken ct)
    {
        page = Math.Clamp(page, 1, 1000000);
        pageSize = Math.Clamp(pageSize, 1, 100);
        var query = db.DshBackups.AsNoTracking().Where(x => (all || x.UserId == userId) && (x.Scope == "all" || x.Scope == "selected"));
        if (!string.IsNullOrWhiteSpace(search)) query = query.Where(x => x.User.Name.Contains(search) || x.User.EmployeeNo.Contains(search));
        var total = await query.CountAsync(ct);
        var items = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new { x.Id, x.UserId, userName = x.User.Name, x.User.EmployeeNo, x.User.LastLoginAt, x.CreatedAt, x.Bytes, x.SessionCount, x.Scope, x.Sha256, canDownload = x.UserId == userId }).ToArrayAsync(ct);
        return Results.Ok(new { items, total, page, pageSize });
    }

    private static async Task<IResult> DownloadAsync(Guid id, Guid userId, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct)
    {
        var row = await db.DshBackups.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.UserId == userId, ct);
        if (row is null) return Results.NotFound();
        var storage = BackupTransferEndpoints.Descriptor(row);
        if (storage is not null && storage.State != "complete") return Results.Conflict();
        if (storage is { StorageKind: "minio-v2", State: "complete" })
            return Results.Stream(output => store.ReadAsync(storage.Key, null, null, stream => stream.CopyToAsync(output, ct), ct), "application/gzip", fileDownloadName: $"dsh-backup-{id:D}.tar.gz");
        var payload = row.Payload;
        if (storage is not null) {
            using var buffer = new MemoryStream();
            await store.ReadAsync(storage.Key, null, null, stream => stream.CopyToAsync(buffer, ct), ct);
            payload = Encoding.UTF8.GetString(buffer.ToArray());
        }
        if (Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(payload))) != row.Sha256)
            return Results.Problem("备份校验失败，请联系管理员", statusCode: 503);
        return Results.Ok(new { payload, sha256 = row.Sha256 });
    }

    private static async Task<IResult> DeleteAsync(Guid id, Guid userId, bool all, AigcHubDbContext db, IBackupObjectStore store, CancellationToken ct)
    {
        await BackupTransferEndpoints.Mutation.WaitAsync(ct);
        try {
        var row = await db.DshBackups.SingleOrDefaultAsync(x => x.Id == id && (all || x.UserId == userId), ct);
        if (row is null) return Results.NotFound();
        var storage = BackupTransferEndpoints.Descriptor(row);
        if (storage is not null) await store.DeleteAsync(storage.Key, storage.State == "complete" ? null : storage.UploadId, ct);
        db.DshBackups.Remove(row);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
        } finally { BackupTransferEndpoints.Mutation.Release(); }
    }
}
