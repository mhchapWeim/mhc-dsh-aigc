using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;

namespace AigcHub.Api.Services;

public static class ProcessBindings
{
    public const string Publication = "publication";
    public const string Access = "access";
    public const string PublicationBusiness = "application-publication";
    public const string AccessBusiness = "application-access";

    public static string Normalize(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        Publication => Publication,
        Access => Access,
        _ => throw new WorkflowException("申请类型必须是发布申请或访问申请")
    };

    public static async Task<ProcessDefinition> ResolvePublishedAsync(AigcHubDbContext db, string requestType, CancellationToken ct)
    {
        var binding = await db.RequestProcessBindings.AsNoTracking().SingleOrDefaultAsync(x => x.RequestType == requestType, ct);
        if (binding is null)
            throw new WorkflowException(requestType == Access
                ? "访问申请尚未绑定流程，请联系管理员发布并绑定后再提交。本次未创建申请"
                : "发布申请尚未绑定流程，请联系管理员配置后再提交。本次未创建申请", 409);
        var definition = await db.ProcessDefinitions.AsNoTracking().OrderByDescending(x => x.Version)
            .FirstOrDefaultAsync(x => x.Key == binding.ProcessKey && x.IsPublished && x.RequestType == requestType, ct);
        if (definition is null)
            throw new WorkflowException("绑定流程没有适用于该申请的已发布版本，本次未创建申请", 409);
        return definition;
    }
}

public static class PublishedApplicationAccess
{
    public static bool HasScope(PublicationRequest app, AppUser user, bool personalGrant)
    {
        if (!user.IsEnabled || app.Status != PublicationStatus.Approved) return false;
        if (app.AccessMode == "All" || personalGrant) return true;
        var roleIds = user.Roles.Select(x => x.RoleId).ToHashSet();
        return app.AccessGrants.Any(grant =>
            (grant.SubjectType == "User" && grant.SubjectId == user.Id) ||
            (grant.SubjectType == "Department" && grant.SubjectId == user.DepartmentId) ||
            (grant.SubjectType == "Role" && roleIds.Contains(grant.SubjectId)));
    }
}

public static class RegisteredApplicationAccess
{
    public static bool HasScope(RegisteredApplication app, AppUser user, bool personalGrant) =>
        app.AccessMode == "All" || personalGrant || app.Grants.Any(grant =>
            (grant.SubjectType == "User" && grant.SubjectId == user.Id) ||
            (grant.SubjectType == "Department" && user.Department?.IsEnabled == true && grant.SubjectId == user.DepartmentId));

    public static IQueryable<ApplicationPersonalGrant> ActiveGrants(AigcHubDbContext db, Guid userId) =>
        db.ApplicationPersonalGrants.AsNoTracking().Where(x =>
            x.UserId == userId && x.RegisteredApplicationId != null && x.RevokedAt == null);
}

public interface IUpstreamProbe
{
    Task<bool> ProbeAsync(Uri upstream, CancellationToken ct);
}

public sealed class HttpUpstreamProbe(IHttpClientFactory clients) : IUpstreamProbe
{
    public async Task<bool> ProbeAsync(Uri upstream, CancellationToken ct)
    {
        try
        {
            var client = clients.CreateClient("upstream-probe");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            using var request = new HttpRequestMessage(HttpMethod.Head, upstream);
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            return true;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            return false;
        }
    }
}

public sealed record GatewayDurations(int IdleTimeoutMinutes, int MaxSessionHours, int LaunchTicketSeconds)
{
    public static GatewayDurations Defaults { get; } = new(30, 8, 60);
    public TimeSpan Idle => TimeSpan.FromMinutes(IdleTimeoutMinutes);
    public TimeSpan Absolute => TimeSpan.FromHours(MaxSessionHours);
    public TimeSpan Ticket => TimeSpan.FromSeconds(LaunchTicketSeconds);

    public static string? Validate(int idle, int hours, int ticket)
    {
        if (idle <= 0 || hours <= 0 || ticket <= 0) return "空闲超时、会话最长时长和启动票据有效期都必须是正整数";
        if (idle > hours * 60L) return "空闲超时不能超过会话最长时长";
        return null;
    }
}

public sealed class ApplicationRouteService(AigcHubDbContext db, IConfiguration configuration, IUpstreamProbe probe)
{
    public const string Ready = "Ready";
    public const string Unavailable = "Unavailable";
    public const string Retired = "Retired";
    private static readonly HashSet<string> Reserved = new(StringComparer.OrdinalIgnoreCase)
    {
        "api", "admin", "health", "swagger", "hubs", "login", "desktop", "apps", "static", "assets", "_next"
    };

    public async Task RegisterAsync(PublicationRequest request, string deploymentUrl, CancellationToken ct)
    {
        if (!Uri.TryCreate(deploymentUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo))
            throw new WorkflowException("部署地址必须是不含账号信息的 HTTPS 地址");
        var allowed = configuration.GetSection("ApplicationGateway:AllowedUpstreamHosts").Get<string[]>() ?? [];
        var probeMode = configuration["ApplicationGateway:Probe"] ?? "off";
        if (probeMode == "required" && allowed.Length == 0)
            throw new WorkflowException("未配置允许的上游主机范围，不能登记路由");
        if (allowed.Length > 0 && !HostAllowed(uri.Host, allowed))
            throw new WorkflowException("部署地址不在允许的上游范围内，未登记路由");
        var publicHost = PublicHost();
        var proxySuffix = AigcHub.Api.Endpoints.ApplicationGatewayHost.GetProxyHostSuffix(configuration);
        if ((!string.IsNullOrEmpty(publicHost) && uri.Host.Equals(publicHost, StringComparison.OrdinalIgnoreCase)) ||
            (proxySuffix is not null && (uri.Host.Equals(proxySuffix, StringComparison.OrdinalIgnoreCase) ||
                uri.Host.EndsWith($".{proxySuffix}", StringComparison.OrdinalIgnoreCase))))
            throw new WorkflowException("部署地址不能指向应用网关自身");
        var reachable = probeMode == "off" || await probe.ProbeAsync(uri, ct);
        if (!reachable && probeMode == "required")
            throw new WorkflowException("上游 TLS 或连通性校验失败，未登记可用路由");
        var existing = await db.ApplicationRoutes.SingleOrDefaultAsync(x => x.PublicationRequestId == request.Id, ct);
        if (existing is null)
        {
            var taken = await db.ApplicationRoutes.Select(x => x.Slug).ToListAsync(ct);
            existing = new ApplicationRoute
            {
                PublicationRequestId = request.Id,
                Slug = CreateSlug(request.AppName, request.Id, taken),
                UpstreamUrl = uri.GetLeftPart(UriPartial.Path),
                Status = reachable ? Ready : Unavailable,
                Detail = reachable ? "已登记" : "地址校验通过，连通性未确认"
            };
            db.ApplicationRoutes.Add(existing);
        }
        else
        {
            existing.UpstreamUrl = uri.GetLeftPart(UriPartial.Path);
            existing.Status = reachable ? Ready : Unavailable;
            existing.Detail = reachable ? "上游已更新" : "地址校验通过，连通性未确认";
            existing.UpdatedAt = DateTimeOffset.UtcNow;
        }
    }

    public static string CreateSlug(string appName, Guid id, IEnumerable<string> taken)
    {
        var ascii = new string((appName ?? "").ToLowerInvariant().Select(ch => char.IsAsciiLetterOrDigit(ch) ? ch : '-').ToArray()).Trim('-');
        while (ascii.Contains("--", StringComparison.Ordinal)) ascii = ascii.Replace("--", "-", StringComparison.Ordinal);
        if (ascii.Length < 2) ascii = "app";
        if (ascii.Length > 40) ascii = ascii[..40].Trim('-');
        var slug = $"{ascii}-{id.ToString("N")[..6]}";
        if (Reserved.Contains(slug) || taken.Contains(slug, StringComparer.OrdinalIgnoreCase)) slug = $"app-{id.ToString("N")[..8]}";
        return slug;
    }

    private string PublicHost()
    {
        var origin = configuration["ApplicationGateway:PublicOrigin"];
        return Uri.TryCreate(origin, UriKind.Absolute, out var uri) ? uri.Host : "";
    }

    private static bool HostAllowed(string host, IEnumerable<string> allowed) => allowed.Any(rule =>
    {
        var item = rule.Trim();
        if (item.StartsWith("*.", StringComparison.Ordinal))
            return host.EndsWith(item[1..], StringComparison.OrdinalIgnoreCase);
        return host.Equals(item, StringComparison.OrdinalIgnoreCase);
    });
}

public sealed class GatewaySettingsService(AigcHubDbContext db)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public async Task<GatewayDurations> CurrentAsync(CancellationToken ct)
    {
        var row = await db.ApplicationGatewaySettings.AsNoTracking().SingleOrDefaultAsync(x => x.Id == 1, ct);
        return row is null ? GatewayDurations.Defaults : new GatewayDurations(row.IdleTimeoutMinutes, row.MaxSessionHours, row.LaunchTicketSeconds);
    }

    public async Task<GatewayDurations> SaveAsync(Guid actorId, int idle, int hours, int ticket, CancellationToken ct)
    {
        var error = GatewayDurations.Validate(idle, hours, ticket);
        if (error is not null) throw new WorkflowException(error);
        var row = await db.ApplicationGatewaySettings.SingleOrDefaultAsync(x => x.Id == 1, ct);
        var before = row is null ? GatewayDurations.Defaults : new GatewayDurations(row.IdleTimeoutMinutes, row.MaxSessionHours, row.LaunchTicketSeconds);
        row ??= new ApplicationGatewaySetting { Id = 1 };
        if (db.Entry(row).State == EntityState.Detached) db.ApplicationGatewaySettings.Add(row);
        row.IdleTimeoutMinutes = idle;
        row.MaxSessionHours = hours;
        row.LaunchTicketSeconds = ticket;
        row.UpdatedAt = DateTimeOffset.UtcNow;
        row.UpdatedById = actorId;
        var after = new GatewayDurations(idle, hours, ticket);
        db.ApplicationGatewaySettingChanges.Add(new ApplicationGatewaySettingChange
        {
            ActorId = actorId,
            BeforeJson = JsonSerializer.Serialize(before, Json),
            AfterJson = JsonSerializer.Serialize(after, Json)
        });
        await db.SaveChangesAsync(ct);
        return after;
    }
}

/// <summary>
/// 流程发布应用的目录/网关启停。与审批、版本、路由和授权分开。
/// 同一应用的签发、兑换和启停共用进程内闸门；PostgreSQL 再对发布记录加行锁，避免停用与发票据互相覆盖。
/// </summary>
public static class PublishedApplicationOperation
{
    private static readonly ConcurrentDictionary<Guid, SemaphoreSlim> Gates = new();
    public static SemaphoreSlim Gate(Guid id) => Gates.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));

    public static bool AcceptsCredential(PublicationRequest? app, long accessEpoch) =>
        app is not null && app.OperationalEnabled && app.Status == PublicationStatus.Approved && app.AccessEpoch == accessEpoch;

    public static async Task<(PublicationRequest App, bool Changed)> SetEnabledAsync(
        AigcHubDbContext db, Guid actorId, Guid id, bool enabled, CancellationToken ct)
    {
        var gate = Gate(id);
        await gate.WaitAsync(ct);
        try
        {
            await using var tx = db.Database.IsRelational()
                ? await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct) : null;
            if (db.Database.IsNpgsql())
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""SELECT "Id" FROM aigc_hub."PublicationRequests" WHERE "Id" = {id} FOR UPDATE""", ct);
            var app = await db.PublicationRequests.Include(x => x.Applicant).SingleOrDefaultAsync(x => x.Id == id, ct)
                ?? throw new WorkflowException("应用不存在", 404);
            if (app.Status != PublicationStatus.Approved)
                throw new WorkflowException("只能管理已发布完成的应用", 409);
            if (app.OperationalEnabled == enabled)
            {
                if (tx is not null) await tx.CommitAsync(ct);
                return (app, false);
            }
            var before = app.OperationalEnabled;
            app.OperationalEnabled = enabled;
            app.AccessEpoch++;
            app.UpdatedAt = DateTimeOffset.UtcNow;
            var now = DateTimeOffset.UtcNow;
            var sessions = await db.ApplicationGatewaySessions.Where(x => x.PublicationRequestId == id && x.ClosedAt == null).ToListAsync(ct);
            foreach (var session in sessions) session.ClosedAt = now;
            db.OperationAudits.Add(new OperationAudit
            {
                UserId = actorId,
                Action = enabled ? "published-application.enable" : "published-application.disable",
                EntityType = "PublicationRequest",
                EntityId = id.ToString(),
                Succeeded = true,
                DetailJson = JsonSerializer.Serialize(new { name = app.AppName, before, after = enabled, accessEpoch = app.AccessEpoch })
            });
            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
            return (app, true);
        }
        finally { gate.Release(); }
    }
}

public sealed class LaunchTicketService(AigcHubDbContext db, GatewaySettingsService settings)
{
    public async Task<(string Token, DateTimeOffset ExpiresAt, string Slug)> IssueAsync(Guid userId, Guid applicationId, CancellationToken ct)
    {
        var gate = PublishedApplicationOperation.Gate(applicationId);
        await gate.WaitAsync(ct);
        try
        {
            await using var tx = db.Database.IsRelational()
                ? await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, ct) : null;
            if (db.Database.IsNpgsql())
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""SELECT "Id" FROM aigc_hub."PublicationRequests" WHERE "Id" = {applicationId} FOR UPDATE""", ct);
            var user = await db.Users.Include(x => x.Roles).SingleOrDefaultAsync(x => x.Id == userId && x.IsEnabled, ct)
                ?? throw new WorkflowException("当前用户不可用", 403);
            var app = await db.PublicationRequests.Include(x => x.AccessGrants).SingleOrDefaultAsync(x => x.Id == applicationId, ct)
                ?? throw new WorkflowException("应用不存在", 404);
            var route = await db.ApplicationRoutes.AsNoTracking().SingleOrDefaultAsync(x => x.PublicationRequestId == applicationId, ct);
            var personal = await db.ApplicationPersonalGrants.AnyAsync(x => x.UserId == userId && x.PublicationRequestId == applicationId && x.RevokedAt == null, ct);
            if (!app.OperationalEnabled)
                throw new WorkflowException("应用已停用，不能启动", 409);
            if (route is null || route.Status != ApplicationRouteService.Ready)
                throw new WorkflowException("应用路由未就绪，不能启动", 409);
            if (!PublishedApplicationAccess.HasScope(app, user, personal))
                throw new WorkflowException("无权访问该应用", 403);
            var durations = await settings.CurrentAsync(ct);
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var expires = DateTimeOffset.UtcNow.Add(durations.Ticket);
            db.ApplicationLaunchTickets.Add(new ApplicationLaunchTicket
            {
                UserId = userId,
                PublicationRequestId = applicationId,
                TokenHash = Hash(token),
                ExpiresAt = expires,
                AccessEpoch = app.AccessEpoch,
                LifetimeSeconds = durations.LaunchTicketSeconds
            });
            await ApplicationClickService.RecordAsync(db, applicationId, userId, Guid.NewGuid(), ct);
            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
            return (token, expires, route.Slug);
        }
        finally { gate.Release(); }
    }

    public async Task<ApplicationLaunchTicket?> ConsumeAsync(string token, Guid applicationId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length > 200) return null;
        var hash = Hash(token.Trim());
        var now = DateTimeOffset.UtcNow;
        var gate = PublishedApplicationOperation.Gate(applicationId);
        await gate.WaitAsync(ct);
        try
        {
            if (db.Database.IsNpgsql())
            {
                var updated = await db.Database.ExecuteSqlInterpolatedAsync(
                    $"""
                    UPDATE aigc_hub."ApplicationLaunchTickets" AS t
                    SET "ConsumedAt" = {now}
                    FROM aigc_hub."PublicationRequests" AS p
                    WHERE t."TokenHash" = {hash} AND t."PublicationRequestId" = {applicationId}
                      AND t."ConsumedAt" IS NULL AND t."ExpiresAt" > {now}
                      AND p."Id" = t."PublicationRequestId" AND p."OperationalEnabled" = TRUE
                      AND p."Status" = {(int)PublicationStatus.Approved} AND p."AccessEpoch" = t."AccessEpoch"
                    """, ct);
                if (updated != 1) return null;
                return await db.ApplicationLaunchTickets.AsNoTracking().SingleAsync(x => x.TokenHash == hash, ct);
            }
            var ticketGate = Gates.GetOrAdd(hash, _ => new SemaphoreSlim(1, 1));
            await ticketGate.WaitAsync(ct);
            try
            {
                var ticket = await db.ApplicationLaunchTickets.SingleOrDefaultAsync(x => x.TokenHash == hash && x.PublicationRequestId == applicationId, ct);
                if (ticket is null || ticket.ConsumedAt is not null || ticket.ExpiresAt <= now) return null;
                var app = await db.PublicationRequests.AsNoTracking().SingleOrDefaultAsync(x => x.Id == applicationId, ct);
                if (!PublishedApplicationOperation.AcceptsCredential(app, ticket.AccessEpoch)) return null;
                ticket.ConsumedAt = now;
                await db.SaveChangesAsync(ct);
                return ticket;
            }
            finally { ticketGate.Release(); }
        }
        finally { gate.Release(); }
    }

    public static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Gates = new();
}

public sealed class GatewaySessionService(AigcHubDbContext db, GatewaySettingsService settings)
{
    public async Task<(ApplicationGatewaySession Session, string Secret)?> OpenAsync(ApplicationLaunchTicket ticket, CancellationToken ct)
    {
        var gate = PublishedApplicationOperation.Gate(ticket.PublicationRequestId);
        await gate.WaitAsync(ct);
        try
        {
            var app = await db.PublicationRequests.AsNoTracking().SingleOrDefaultAsync(x => x.Id == ticket.PublicationRequestId, ct);
            var route = await db.ApplicationRoutes.AsNoTracking().SingleOrDefaultAsync(x => x.PublicationRequestId == ticket.PublicationRequestId, ct);
            if (route is null || route.Status != ApplicationRouteService.Ready || !PublishedApplicationOperation.AcceptsCredential(app, ticket.AccessEpoch))
                return null;
            var durations = await settings.CurrentAsync(ct);
            var now = DateTimeOffset.UtcNow;
            var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var session = new ApplicationGatewaySession
            {
                UserId = ticket.UserId,
                PublicationRequestId = ticket.PublicationRequestId,
                CookieHash = LaunchTicketService.Hash(secret),
                CreatedAt = now,
                LastActivityAt = now,
                AbsoluteExpiresAt = now.Add(durations.Absolute),
                IdleTimeoutSeconds = (int)durations.Idle.TotalSeconds,
                AccessEpoch = app!.AccessEpoch
            };
            db.ApplicationGatewaySessions.Add(session);
            await db.SaveChangesAsync(ct);
            return (session, secret);
        }
        finally { gate.Release(); }
    }

    public async Task<ApplicationGatewaySession?> AuthorizeAsync(string? cookie, Guid? routeApplicationId, bool activity, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(cookie)) return null;
        var hash = LaunchTicketService.Hash(cookie);
        var session = await db.ApplicationGatewaySessions.SingleOrDefaultAsync(x => x.CookieHash == hash, ct);
        if (session is null || session.ClosedAt is not null) return null;
        var now = DateTimeOffset.UtcNow;
        if (now >= session.AbsoluteExpiresAt || now - session.LastActivityAt >= TimeSpan.FromSeconds(session.IdleTimeoutSeconds))
        {
            session.ClosedAt = now;
            await db.SaveChangesAsync(ct);
            return null;
        }
        if (routeApplicationId is not null && session.PublicationRequestId != routeApplicationId) return null;
        var gate = PublishedApplicationOperation.Gate(session.PublicationRequestId);
        await gate.WaitAsync(ct);
        try
        {
            var user = await db.Users.Include(x => x.Roles).SingleOrDefaultAsync(x => x.Id == session.UserId, ct);
            var app = await db.PublicationRequests.Include(x => x.AccessGrants).SingleOrDefaultAsync(x => x.Id == session.PublicationRequestId, ct);
            var route = await db.ApplicationRoutes.AsNoTracking().SingleOrDefaultAsync(x => x.PublicationRequestId == session.PublicationRequestId, ct);
            var personal = user is not null && await db.ApplicationPersonalGrants.AnyAsync(
                x => x.UserId == session.UserId && x.PublicationRequestId == session.PublicationRequestId && x.RevokedAt == null, ct);
            var stillOpen = await db.ApplicationGatewaySessions.AsNoTracking().AnyAsync(x => x.Id == session.Id && x.ClosedAt == null, ct);
            if (!stillOpen || user is null || app is null || route is null || route.Status != ApplicationRouteService.Ready
                || !PublishedApplicationOperation.AcceptsCredential(app, session.AccessEpoch)
                || !PublishedApplicationAccess.HasScope(app, user, personal))
            {
                await CloseIfOpenAsync(session.Id, now, ct);
                session.ClosedAt = now;
                return null;
            }
            if (activity && await TouchIfOpenAsync(session, now, ct) != 1) return null;
            return session;
        }
        finally { gate.Release(); }
    }

    private async Task CloseIfOpenAsync(Guid id, DateTimeOffset now, CancellationToken ct)
    {
        if (db.Database.IsRelational())
        {
            await db.ApplicationGatewaySessions.Where(x => x.Id == id && x.ClosedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ClosedAt, now), ct);
            return;
        }
        var current = await db.ApplicationGatewaySessions.SingleOrDefaultAsync(x => x.Id == id && x.ClosedAt == null, ct);
        if (current is null) return;
        current.ClosedAt = now;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// 只刷新仍打开的会话。PostgreSQL 用条件更新，避免后写入把已关闭会话重新打开；
    /// 内存库没有该更新，改在同一应用闸门内重读后再保存。
    /// </summary>
    private async Task<int> TouchIfOpenAsync(ApplicationGatewaySession session, DateTimeOffset now, CancellationToken ct)
    {
        if (db.Database.IsRelational())
            return await db.ApplicationGatewaySessions.Where(x => x.Id == session.Id && x.ClosedAt == null)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.LastActivityAt, now), ct);
        await db.Entry(session).ReloadAsync(ct);
        if (session.ClosedAt is not null) return 0;
        session.LastActivityAt = now;
        await db.SaveChangesAsync(ct);
        return 1;
    }

    public static bool CountsAsActivity(string path, string? activityHeader, bool pollQuery)
    {
        if (string.Equals(activityHeader, "poll", StringComparison.OrdinalIgnoreCase) || pollQuery) return false;
        var leaf = path.TrimEnd('/');
        return !(leaf.EndsWith("/heartbeat", StringComparison.OrdinalIgnoreCase)
            || leaf.EndsWith("/healthz", StringComparison.OrdinalIgnoreCase)
            || leaf.EndsWith("/ping", StringComparison.OrdinalIgnoreCase));
    }
}
