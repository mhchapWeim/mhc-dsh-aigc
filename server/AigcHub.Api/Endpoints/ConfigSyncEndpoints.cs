using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class ConfigSyncEndpoints
{
    public static void MapConfigSyncEndpoints(this IEndpointRouteBuilder app)
    {
        var dsh = app.MapGroup("/v1/config").WithTags("DSH 配置热更新");
        dsh.MapGet("/versions", async (HttpRequest request, AigcHubDbContext db, ConfigSyncService sync, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            return user is null ? Results.Unauthorized() : Results.Ok(new { schemaVersion = 1, userId = user.Id, revision = await sync.RevisionAsync(ct) });
        });
        dsh.MapGet("/snapshot", async (Guid deviceId, HttpRequest request, AigcHubDbContext db, ConfigSyncService sync, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            return user is null ? Results.Unauthorized() : Results.Ok(await sync.SnapshotAsync(user, deviceId, ct));
        });
        dsh.MapPost("/applied", async (ConfigSyncReport input, HttpRequest request, AigcHubDbContext db, ConfigSyncService sync, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            if (user is null) return Results.Unauthorized();
            await sync.ReportAsync(user.Id, input, ct); return Results.NoContent();
        });
        dsh.MapGet("/events", StreamAsync);

        app.MapGet("/api/config-sync/devices", async (int page, int pageSize, string? search, string? status,
            AigcHubDbContext db, ConfigSyncService sync, ConfigSyncSignals signals, IOptions<ConfigSyncOptions> options, CancellationToken ct) =>
        {
            (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
            var target = await sync.RevisionAsync(ct);
            var usersQuery = db.Users.AsNoTracking().Where(x => x.IsEnabled);
            if (!string.IsNullOrWhiteSpace(search)) usersQuery = usersQuery.Where(x => x.EmployeeNo.Contains(search) || x.Name.Contains(search));
            var rows = (from user in usersQuery
                join device in db.ConfigSyncDevices.AsNoTracking() on user.Id equals device.UserId into devices
                from device in devices.DefaultIfEmpty()
                select new { user.Id, user.EmployeeNo, user.Name, DeviceId = device == null ? (Guid?)null : device.DeviceId,
                    DeviceName = device == null ? "" : device.DeviceName, ClientVersion = device == null ? "" : device.ClientVersion,
                    AppliedRevision = device == null ? -1 : device.AppliedRevision,
                    AttemptedRevision = device == null ? -1 : device.AttemptedRevision,
                    LastSeenAt = device == null ? (DateTimeOffset?)null : device.LastSeenAt,
                    AppliedAt = device == null ? (DateTimeOffset?)null : device.AppliedAt,
                    ErrorCode = device == null ? "" : device.ErrorCode,
                    DeviceStatus = device == null ? "" : device.Status });
            var cutoff = DateTimeOffset.UtcNow.AddSeconds(-90);
            var result = rows.Select(x => new { UserId = x.Id, x.EmployeeNo, UserName = x.Name, x.DeviceId, x.DeviceName, x.ClientVersion,
                TargetRevision = target, x.AppliedRevision, x.AttemptedRevision, x.LastSeenAt, x.AppliedAt, x.ErrorCode,
                Status = x.DeviceId == null ? "Unreported" : x.LastSeenAt < cutoff ? "Offline" : x.AppliedRevision >= target ? "Applied"
                    : x.DeviceStatus == "Failed" ? "Failed" : "Pending" });
            var selected = result.Where(x => string.IsNullOrEmpty(status) || x.Status == status).OrderBy(x => x.EmployeeNo).ThenBy(x => x.DeviceId);
            return Results.Ok(new { revision = target, mqEnabled = options.Value.Enabled, mqConnected = signals.MqConnected, mqErrorCode = signals.MqErrorCode,
                pendingEvents = await db.ConfigSyncEvents.CountAsync(x => x.Status != "Sent", ct),
                page, pageSize, total = await selected.CountAsync(ct), items = await selected.Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct),
                summary = new { applied = await result.CountAsync(x => x.Status == "Applied", ct), pending = await result.CountAsync(x => x.Status == "Pending", ct),
                    failed = await result.CountAsync(x => x.Status == "Failed", ct), offline = await result.CountAsync(x => x.Status == "Offline", ct), unreported = await result.CountAsync(x => x.Status == "Unreported", ct) } });
        }).RequireAuthorization("model.manage").WithTags("配置更新状态");
    }

    private static async Task StreamAsync(HttpContext context, AigcHubDbContext db, ConfigSyncService sync, ConfigSyncSignals signals)
    {
        var ct = context.RequestAborted;
        if (await DshManagedEndpoints.UserAsync(context.Request, db, ct) is null) { context.Response.StatusCode = 401; return; }
        context.Response.ContentType = "text/event-stream";
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        var subscription = signals.Subscribe();
        try
        {
            long previous = -1;
            while (!ct.IsCancellationRequested)
            {
                var user = await DshManagedEndpoints.UserAsync(context.Request, db, ct);
                if (user is null) { await context.Response.WriteAsync("event: auth.revoked\ndata: {}\n\n", ct); break; }
                var revision = await sync.RevisionAsync(ct);
                var payload = JsonSerializer.Serialize(new { schemaVersion = 1, revision, userId = user.Id });
                await context.Response.WriteAsync($"event: {(revision != previous ? "config.changed" : "heartbeat")}\ndata: {payload}\n\n", ct);
                await context.Response.Body.FlushAsync(ct); previous = revision;
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct); wait.CancelAfter(TimeSpan.FromSeconds(15));
                try { await subscription.Reader.ReadAsync(wait.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        finally { signals.Remove(subscription.Id); }
    }
}
