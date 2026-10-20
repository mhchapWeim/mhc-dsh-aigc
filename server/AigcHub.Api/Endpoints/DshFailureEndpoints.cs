using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class DshFailureEndpoints
{
    private static readonly SemaphoreSlim IngestGate = new(1, 1);
    public sealed record Batch(JsonElement[] Events);
    public static void MapDshFailureEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/v1/desktop/diagnostics", IngestAsync).WithMetadata(new RequestSizeLimitAttribute(1024 * 1024));
        app.MapPost("/v1/desktop/installer-diagnostics", IngestInstallerAsync).AllowAnonymous()
            .RequireRateLimiting("installer-diagnostics").WithMetadata(new RequestSizeLimitAttribute(64 * 1024));
        var admin = app.MapGroup("/api/dsh-failures").RequireAuthorization("diagnostic.manage").WithTags("DSH 失败日志");
        admin.MapGet("/", ListAsync);
        admin.MapGet("/{id:guid}", DetailAsync);
        admin.MapGet("/{id:guid}/download", DownloadAsync);
    }

    // Installation precedes authentication. This endpoint accepts only bounded installer facts,
    // never a claimed AIGC identity, arbitrary category, session log, or management credential.
    public sealed record InstallerFailure(Guid EventId, Guid DeviceId, DateTimeOffset OccurredAt,
        string AppVersion, string Stage, int Code, string Error, string InstallPath,
        bool Elevated, string WindowsVersion, string ComputerName);

    private static async Task<IResult> IngestInstallerAsync(InstallerFailure input, AigcHubDbContext db, CancellationToken ct)
    {
        if (input.EventId == Guid.Empty || input.DeviceId == Guid.Empty
            || input.OccurredAt > DateTimeOffset.UtcNow.AddMinutes(10) || input.OccurredAt < DshFailureCleanup.Cutoff
            || string.IsNullOrWhiteSpace(input.AppVersion) || input.AppVersion.Length > 128
            || input.Stage is not ("preflight" or "staging" or "extract" or "promote" or "install" or "launch")
            || string.IsNullOrWhiteSpace(input.Error) || input.Error.Length > 24_000
            || input.InstallPath is null || input.InstallPath.Length > 1024
            || input.WindowsVersion is null || input.WindowsVersion.Length > 256
            || input.ComputerName is null || input.ComputerName.Length > 256)
            return Results.BadRequest(new { message = "无效的安装失败日志" });
        var payload = JsonSerializer.Serialize(new {
            schemaVersion = 1, eventId = input.EventId, deviceId = input.DeviceId,
            username = "", identitySource = "unauthenticated-installer", appVersion = Scrub(input.AppVersion),
            occurredAt = input.OccurredAt.ToUniversalTime(), category = "installer", operation = input.Stage,
            operationId = input.EventId.ToString(), error = Scrub(input.Error), platform = "win32", arch = "x64",
            context = new[] { $"Install path: {Scrub(input.InstallPath)}", $"Code: {input.Code}",
                $"Elevated: {input.Elevated}", $"Windows: {Scrub(input.WindowsVersion)}", $"Computer: {Scrub(input.ComputerName)}" }
        });
        await IngestGate.WaitAsync(ct);
        try {
            if (!await db.DshFailures.AnyAsync(x => x.UserId == null && x.EventId == input.EventId, ct)) {
                db.DshFailures.Add(new DshFailure { EventId = input.EventId, DeviceId = input.DeviceId.ToString(),
                    AppVersion = Scrub(input.AppVersion), Category = "installer", Operation = input.Stage,
                    OperationId = input.EventId.ToString(), OccurredAt = input.OccurredAt.ToUniversalTime(), PayloadJson = payload });
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
                { return Results.StatusCode(503); }
            }
        } finally { IngestGate.Release(); }
        return Results.Ok(new { acceptedEventIds = new[] { input.EventId }, retentionDays = 7 });
    }

    private static string? Text(JsonElement value, string key, int max, bool required = false)
    {
        if (!value.TryGetProperty(key, out var field) || field.ValueKind == JsonValueKind.Null) return required ? null : "";
        return field.ValueKind == JsonValueKind.String && field.GetString() is { } text && text.Length <= max
            && (!required || !string.IsNullOrWhiteSpace(text)) ? text : null;
    }

    // Defense in depth for clients that do not implement the current local scrubber.
    internal static string Scrub(string value) => Regex.Replace(Regex.Replace(Regex.Replace(Regex.Replace(Regex.Replace(value,
        @"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[REDACTED PRIVATE KEY]"),
        @"\bBearer\s+[^\s""',;]+|\bsk-[A-Za-z0-9_-]+|\b[a-f0-9]{64}\b", "[REDACTED CREDENTIAL]", RegexOptions.IgnoreCase),
        @"((?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)\s*[""']?\s*[:=]\s*[""']?)[^\s""',;}&]+", "$1[REDACTED]", RegexOptions.IgnoreCase),
        @"([?&](?:code|ticket|key|token|password|secret)=)[^&#\s]+", "$1[REDACTED]", RegexOptions.IgnoreCase),
        @"(https?://)[^\s/@]+:[^\s/@]+@", "$1[REDACTED]@", RegexOptions.IgnoreCase);

    private static async Task<IResult> IngestAsync(Batch input, HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (input.Events is null || input.Events.Length is < 1 or > 20) return Results.BadRequest(new { message = "每批允许 1–20 条日志" });
        var rows = new List<DshFailure>();
        var accepted = new HashSet<Guid>();
        foreach (var value in input.Events)
        {
            if (value.ValueKind != JsonValueKind.Object || value.GetRawText().Length > 60_000
                || !value.TryGetProperty("schemaVersion", out var schema) || schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var version) || version != 1
                || !Guid.TryParse(Text(value, "eventId", 36, true), out var eventId)
                || !Guid.TryParse(Text(value, "deviceId", 36, true), out var deviceId)
                || !value.TryGetProperty("occurredAt", out var at) || at.ValueKind != JsonValueKind.String || !at.TryGetDateTimeOffset(out var occurred)
                || occurred > DateTimeOffset.UtcNow.AddMinutes(10)) return Results.BadRequest(new { message = "无效的诊断日志" });
            var username = Text(value, "username", 256);
            if (username is null || (username.Length > 0 && !username.Equals(user.EmployeeNo, StringComparison.OrdinalIgnoreCase)))
                return Results.BadRequest(new { message = "日志所属账号与当前登录不匹配" });
            var category = Text(value, "category", 128, true); var operation = Text(value, "operation", 24_000, true);
            var appVersion = Text(value, "appVersion", 128, true); var sessionId = Text(value, "sessionId", 1024); var operationId = Text(value, "operationId", 1024);
            var error = Text(value, "error", 24_000);
            if (category is null || operation is null || appVersion is null || sessionId is null || operationId is null || error is null)
                return Results.BadRequest(new { message = "日志字段超出限制" });
            var context = new JsonArray();
            if (value.TryGetProperty("context", out var ctx) && ctx.ValueKind != JsonValueKind.Null)
            {
                if (ctx.ValueKind != JsonValueKind.Array || ctx.GetArrayLength() > 20) return Results.BadRequest();
                foreach (var line in ctx.EnumerateArray())
                {
                    if (line.ValueKind != JsonValueKind.String || line.GetString()!.Length > 1024) return Results.BadRequest();
                    context.Add(Scrub(line.GetString()!));
                }
            }
            if (!accepted.Add(eventId) || occurred < DshFailureCleanup.Cutoff) continue;
            var payload = new JsonObject { ["schemaVersion"] = 1, ["eventId"] = eventId.ToString(), ["deviceId"] = deviceId.ToString(),
                ["username"] = user.EmployeeNo, ["appVersion"] = Scrub(appVersion), ["occurredAt"] = occurred.ToUniversalTime(),
                ["category"] = Scrub(category), ["operation"] = Scrub(operation), ["sessionId"] = Scrub(sessionId),
                ["operationId"] = Scrub(operationId), ["error"] = Scrub(error), ["context"] = context };
            foreach (var key in new[] { "durationMs", "status", "pid" })
                if (value.TryGetProperty(key, out var number) && number.ValueKind == JsonValueKind.Number && number.TryGetInt64(out var integer) && integer >= 0) payload[key] = integer;
            foreach (var key in new[] { "platform", "arch" })
                if (Text(value, key, 64) is { } text) payload[key] = Scrub(text);
            rows.Add(new DshFailure { UserId = user.Id, EventId = eventId, DeviceId = deviceId.ToString(), AppVersion = Scrub(appVersion),
                Category = Scrub(category), Operation = Scrub(operation), SessionId = Scrub(sessionId), OperationId = Scrub(operationId),
                OccurredAt = occurred.ToUniversalTime(), PayloadJson = payload.ToJsonString() });
        }
        await IngestGate.WaitAsync(ct);
        try
        {
            var ids = rows.Select(x => x.EventId).ToArray();
            var existing = await db.DshFailures.Where(x => x.UserId == user.Id && ids.Contains(x.EventId)).Select(x => x.EventId).ToArrayAsync(ct);
            db.DshFailures.AddRange(rows.Where(x => !existing.Contains(x.EventId)));
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
            { return Results.StatusCode(503); } // Another API replica won; retry safely against the unique index.
        }
        finally { IngestGate.Release(); }
        return Results.Ok(new { acceptedEventIds = accepted, retentionDays = 7 });
    }

    private static async Task<IResult> ListAsync(AigcHubDbContext db, CancellationToken ct, string? user = null, string? device = null,
        string? version = null, string? category = null, DateTimeOffset? from = null, DateTimeOffset? to = null, int page = 1, int pageSize = 5)
    {
        if (page < 1 || page > 100_000 || (from.HasValue && to.HasValue && from > to)) return Results.BadRequest();
        pageSize = Math.Clamp(pageSize, 1, 100);
        var query = db.DshFailures.AsNoTracking().Where(x => x.OccurredAt >= DshFailureCleanup.Cutoff);
        if (!string.IsNullOrWhiteSpace(user)) query = query.Where(x => x.User != null && (x.User.EmployeeNo.Contains(user) || x.User.Name.Contains(user)));
        if (!string.IsNullOrWhiteSpace(device)) query = query.Where(x => x.DeviceId.Contains(device));
        if (!string.IsNullOrWhiteSpace(version)) query = query.Where(x => x.AppVersion.Contains(version));
        if (!string.IsNullOrWhiteSpace(category)) query = query.Where(x => x.Category == category);
        if (from.HasValue) query = query.Where(x => x.OccurredAt >= from.Value.ToUniversalTime());
        if (to.HasValue) query = query.Where(x => x.OccurredAt <= to.Value.ToUniversalTime());
        var total = await query.CountAsync(ct);
        var items = await query.OrderByDescending(x => x.OccurredAt).ThenBy(x => x.Id).Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new { x.Id, x.EventId, x.DeviceId, x.AppVersion, x.Category, x.Operation, x.SessionId, x.OccurredAt, x.ReceivedAt,
                username = x.User == null ? "" : x.User.EmployeeNo, displayName = x.User == null ? "安装器（未登录）" : x.User.Name }).ToArrayAsync(ct);
        return Results.Ok(new { items, total, page, pageSize, retentionDays = 7 });
    }

    private static async Task<IResult> DetailAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.DshFailures.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.OccurredAt >= DshFailureCleanup.Cutoff, ct);
        return item is null ? Results.NotFound() : Results.Content(item.PayloadJson, "application/json", Encoding.UTF8);
    }
    private static async Task<IResult> DownloadAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.DshFailures.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.OccurredAt >= DshFailureCleanup.Cutoff, ct);
        return item is null ? Results.NotFound() : Results.File(Encoding.UTF8.GetBytes(item.PayloadJson + "\n"), "application/x-ndjson", $"dsh-failure-{item.EventId}.jsonl");
    }
}
