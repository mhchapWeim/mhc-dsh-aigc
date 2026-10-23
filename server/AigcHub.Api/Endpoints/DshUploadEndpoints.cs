using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class DshUploadEndpoints
{
    private static readonly SemaphoreSlim Gate = new(1, 1);

    private sealed record StartInput(Guid UserId, string ClientUploadId, string SessionId, long EventSeq, string Prompt,
        string DeviceId, string ComputerName, string StoredPath, string FileName, long Bytes, string? Sha256 = null);

    public static void MapDshUploadEndpoints(this IEndpointRouteBuilder app)
    {
        var uploads = app.MapGroup("/v1/uploads").WithTags("DSH 文件同步");
        uploads.MapPost("/", StartAsync);
        uploads.MapGet("/{clientUploadId}", StatusAsync);
        uploads.MapPut("/{clientUploadId}/chunk", ChunkAsync);
        uploads.MapPost("/{clientUploadId}/complete", CompleteAsync);
        var admin = app.MapGroup("/api/dsh-uploads").WithTags("DSH 文件管理").RequireAuthorization("model.manage");
        admin.MapGet("/", ListAsync);
        admin.MapGet("/batches", ListBatchesAsync);
        admin.MapGet("/{id:guid}/download", DownloadAsync);
    }

    private static string Root(IConfiguration config, IWebHostEnvironment environment) =>
        Path.GetFullPath(config["DshUploads:Root"] ?? Path.Combine(environment.ContentRootPath, "data", "dsh-uploads"));

    private static string Final(string root, DshUpload upload) => Path.Combine(root, $"{upload.Id:N}.bin");
    private static object View(DshUpload upload) => new
    {
        upload.ClientUploadId, upload.Offset, upload.Bytes, upload.Completed
    };

    private static async Task<IResult> ListAsync(int? page, int? pageSize, string? query, string? status,
        AigcHubDbContext db, CancellationToken ct)
    {
        var currentPage = Math.Clamp(page ?? 1, 1, 1_000_000);
        var currentPageSize = Math.Clamp(pageSize ?? 10, 1, 100);
        var uploads = FilterUploads(db, query, status, out var error);
        if (error is not null) return error;
        var total = await uploads.CountAsync(ct);
        var items = await uploads.OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id)
            .Skip((currentPage - 1) * currentPageSize).Take(currentPageSize).Select(x => new
        {
            x.Id, x.ClientUploadId, x.SessionId, x.EventSeq, x.Prompt, x.ComputerName,
            x.StoredPath, x.FileName, x.Bytes, x.Offset, x.Completed, x.CreatedAt, x.CompletedAt,
            UserName = x.User.Name, x.User.EmployeeNo,
            Status = x.Sha256 == "" ? "Recorded" : x.Completed ? "Completed" : x.Offset == x.Bytes ? "Finalizing" : x.Offset == 0 ? "Pending" : "Uploading"
        }).ToArrayAsync(ct);
        return Results.Ok(new { items, page = currentPage, pageSize = currentPageSize, total });
    }

    private static async Task<IResult> ListBatchesAsync(int? page, int? pageSize, string? query, string? status,
        AigcHubDbContext db, CancellationToken ct)
    {
        var currentPage = Math.Clamp(page ?? 1, 1, 1_000_000);
        var currentPageSize = Math.Clamp(pageSize ?? 10, 1, 100);
        var matches = FilterUploads(db, query, status, out var error);
        if (error is not null) return error;
        var groups = matches.GroupBy(x => new { x.UserId, x.SessionId, x.EventSeq });
        var total = await groups.CountAsync(ct);
        var keys = await groups.Select(group => new
        {
            group.Key.UserId, group.Key.SessionId, group.Key.EventSeq,
            CreatedAt = group.Max(x => x.CreatedAt)
        }).OrderByDescending(x => x.CreatedAt).ThenBy(x => x.SessionId).ThenBy(x => x.EventSeq)
            .Skip((currentPage - 1) * currentPageSize).Take(currentPageSize).ToArrayAsync(ct);
        var batches = new List<object>(keys.Length);
        foreach (var key in keys)
        {
            var files = await db.DshUploads.AsNoTracking()
                .Where(x => x.UserId == key.UserId && x.SessionId == key.SessionId && x.EventSeq == key.EventSeq)
                .OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Select(x => new
                {
                    x.Id, x.ClientUploadId, x.SessionId, x.EventSeq, x.Prompt, x.ComputerName,
                    x.StoredPath, x.FileName, x.Bytes, x.Offset, x.Completed, x.CreatedAt, x.CompletedAt,
                    UserName = x.User.Name, x.User.EmployeeNo,
                    Status = x.Sha256 == "" ? "Recorded" : x.Completed ? "Completed" : x.Offset == x.Bytes ? "Finalizing" : x.Offset == 0 ? "Pending" : "Uploading"
                }).ToArrayAsync(ct);
            batches.Add(new { key.UserId, key.SessionId, key.EventSeq, key.CreatedAt, files });
        }
        return Results.Ok(new { items = batches, page = currentPage, pageSize = currentPageSize, total });
    }

    private static IQueryable<DshUpload> FilterUploads(AigcHubDbContext db, string? query, string? status,
        out IResult? error)
    {
        error = null;
        var uploads = db.DshUploads.AsNoTracking().AsQueryable();
        if (!string.IsNullOrWhiteSpace(query))
        {
            var term = query.Trim();
            if (term.Length > 200)
            {
                error = Results.BadRequest(new { error = "query is too long" });
                return uploads;
            }
            var normalized = term.ToLowerInvariant();
            uploads = uploads.Where(x => x.FileName.ToLower().Contains(normalized) || x.User.Name.ToLower().Contains(normalized)
                || x.User.EmployeeNo.ToLower().Contains(normalized) || x.ComputerName.ToLower().Contains(normalized));
        }
        if (status is not null and not ("" or "Pending" or "Uploading" or "Finalizing" or "Completed" or "Recorded"))
        {
            error = Results.BadRequest(new { error = "invalid upload status" });
            return uploads;
        }
        return status switch
        {
            "Pending" => uploads.Where(x => !x.Completed && x.Offset == 0 && x.Offset != x.Bytes),
            "Uploading" => uploads.Where(x => !x.Completed && x.Offset > 0 && x.Offset < x.Bytes),
            "Finalizing" => uploads.Where(x => !x.Completed && x.Offset == x.Bytes),
            "Completed" => uploads.Where(x => x.Completed && x.Sha256 != ""),
            "Recorded" => uploads.Where(x => x.Sha256 == ""),
            _ => uploads
        };
    }

    private static async Task<IResult> DownloadAsync(Guid id, AigcHubDbContext db,
        IConfiguration config, IWebHostEnvironment environment, CancellationToken ct)
    {
        var upload = await db.DshUploads.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (upload is null) return Results.NotFound();
        if (upload.Sha256 == "") return Results.Conflict(new { error = "此记录仅保存文件名及相关信息，未上传文件内容" });
        if (!upload.Completed) return Results.Conflict(new { error = "upload is not complete" });
        var path = Final(Root(config, environment), upload);
        if (!File.Exists(path) || new FileInfo(path).Length != upload.Bytes)
            return Results.Problem("The completed upload is unavailable on disk.", statusCode: 503);
        return Results.File(path, "application/octet-stream", upload.FileName, enableRangeProcessing: true);
    }

    private static async Task<IResult> StartAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (request.ContentLength is null or > 2_000_000) return Results.StatusCode(413);
        StartInput? input;
        try { input = await JsonSerializer.DeserializeAsync<StartInput>(request.Body,
            new JsonSerializerOptions(JsonSerializerDefaults.Web), ct); }
        catch (JsonException) { return Results.BadRequest(new { error = "invalid JSON" }); }
        if (input is null || input.UserId != user.Id) return Results.StatusCode(403);
        if (input.ClientUploadId is null || input.SessionId is null || input.Prompt is null
            || input.DeviceId is null || input.ComputerName is null || input.StoredPath is null
            || input.FileName is null)
            return Results.BadRequest(new { error = "invalid upload metadata" });
        if (input.ClientUploadId.Length is < 1 or > 180
            || input.SessionId.Length is < 1 or > 180 || input.EventSeq < 0
            || input.Prompt.Length > 200_000 || input.DeviceId.Length is < 1 or > 180
            || input.ComputerName.Length is < 1 or > 180 || input.StoredPath.Length > 2048
            || input.FileName.Length is < 1 or > 255 || input.Bytes < 0
            || (input.Sha256 is not null && (input.Sha256.Length != 64 || !input.Sha256.All(Uri.IsHexDigit))))
            return Results.BadRequest(new { error = "invalid upload metadata" });
        await Gate.WaitAsync(ct);
        try
        {
            var existing = await db.DshUploads.SingleOrDefaultAsync(x => x.UserId == user.Id && x.ClientUploadId == input.ClientUploadId, ct);
            if (existing is not null)
            {
                if (existing.SessionId != input.SessionId || existing.EventSeq != input.EventSeq
                    || existing.Bytes != input.Bytes || existing.Prompt != input.Prompt
                    || existing.FileName != Path.GetFileName(input.FileName.Replace('\\', '/')))
                    return Results.Conflict(new { error = "upload id already belongs to different content" });
                await RecordPendingAsync(existing, db, ct);
                return Results.Ok(View(existing));
            }
            var upload = new DshUpload
            {
                UserId = user.Id, ClientUploadId = input.ClientUploadId, SessionId = input.SessionId,
                EventSeq = input.EventSeq, Prompt = input.Prompt, DeviceId = input.DeviceId,
                ComputerName = input.ComputerName, StoredPath = input.StoredPath,
                FileName = Path.GetFileName(input.FileName.Replace('\\', '/')), Bytes = input.Bytes,
                Sha256 = "", Offset = 0, Completed = true, CompletedAt = DateTimeOffset.UtcNow
            };
            db.DshUploads.Add(upload);
            await db.SaveChangesAsync(ct);
            return Results.Ok(View(upload));
        }
        finally { Gate.Release(); }
    }

    private static async Task<IResult> StatusAsync(string clientUploadId, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        await Gate.WaitAsync(ct);
        try
        {
            var upload = await db.DshUploads.SingleOrDefaultAsync(x => x.UserId == user.Id && x.ClientUploadId == clientUploadId, ct);
            if (upload is null) return Results.NotFound();
            await RecordPendingAsync(upload, db, ct);
            return Results.Ok(View(upload));
        }
        finally { Gate.Release(); }
    }

    // Retained for installed clients; attachment review no longer accepts file bodies.
    private static async Task<IResult> ChunkAsync(string clientUploadId, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        await Gate.WaitAsync(ct);
        try
        {
            var upload = await db.DshUploads.SingleOrDefaultAsync(x => x.UserId == user.Id && x.ClientUploadId == clientUploadId, ct);
            if (upload is null) return Results.NotFound();
            await RecordPendingAsync(upload, db, ct);
            // An installed worker can already be streaming a file during rollout. Refuse
            // the body; its next registration observes completion and drops the task.
            return Results.Problem("附件审查仅保存文件名及相关信息，不再接收文件内容", statusCode: 410);
        }
        finally { Gate.Release(); }
    }

    // Completion acknowledges the audit record, not receipt of file bytes. Keep completed
    // historical uploads intact; never inspect or delete partial files during conversion.
    private static async Task RecordPendingAsync(DshUpload upload, AigcHubDbContext db, CancellationToken ct)
    {
        if (upload.Completed) return;
        upload.Sha256 = "";
        upload.Offset = 0;
        upload.Completed = true;
        upload.CompletedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    private static Task<IResult> CompleteAsync(string clientUploadId, HttpRequest request,
        AigcHubDbContext db, CancellationToken ct) =>
        StatusAsync(clientUploadId, request, db, ct);
}
