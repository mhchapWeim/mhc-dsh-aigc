using System.Net.Http.Headers;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

/// <summary>Independent MCP catalog and authenticated streaming gateway.</summary>
public static class McpMarketEndpoints
{
    public static string Resource(Guid id) => $"mcp:{id:D}";
    private static string Purpose(Guid id) => $"AigcHub.Mcp.{id:D}.v1";
    public sealed record Input(string Name, string Description, string Url, bool IsEnabled, int TimeoutSeconds,
        AccessGrantSelection Grants, string? ServerSecret, bool ClearSecret = false,
        McpAuthenticationMode AuthenticationMode = McpAuthenticationMode.GatewayBearer,
        string TokenExchangeUrl = "", string AssertionAudience = "", string TokenResource = "", string TokenScopes = "");

    public static void MapMcpMarketEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/mcp").RequireAuthorization("mcp.manage").WithTags("MCP 市场");
        admin.MapGet("/", ListAsync);
        admin.MapGet("/grant-options", OptionsAsync);
        admin.MapPost("/", (Input input, AigcHubDbContext db, AccessGrantService grants, IDataProtectionProvider protection,
            ICurrentUser current, CancellationToken ct) => SaveAsync(null, input, db, grants, protection, current, ct));
        admin.MapPut("/{id:guid}", (Guid id, Input input, AigcHubDbContext db, AccessGrantService grants,
            IDataProtectionProvider protection, ICurrentUser current, CancellationToken ct) => SaveAsync(id, input, db, grants, protection, current, ct));
        admin.MapPost("/{id:guid}/icon", IconAsync).DisableAntiforgery().WithMetadata(new RequestSizeLimitAttribute(600_000));
        admin.MapPost("/{id:guid}/test", TestAsync);
        app.MapGet("/v1/mcp/policy", PolicyAsync);
        app.MapPost("/v1/mcp/{id:guid}/identity-assertion", AssertionAsync);
        app.MapMethods("/v1/mcp/{id:guid}/gateway", ["POST", "GET", "DELETE"], GatewayAsync)
            .WithMetadata(new RequestSizeLimitAttribute(2_000_000));
    }

    private static async Task<IResult> OptionsAsync(AigcHubDbContext db, CancellationToken ct) => Results.Ok(new {
        users = await db.Users.Where(x => x.IsEnabled).Select(x => new { x.Id, x.Name, x.EmployeeNo }).ToArrayAsync(ct),
        roles = await db.Roles.Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct),
        departments = await db.Departments.Where(x => x.IsEnabled).Select(x => new { x.Id, x.Name, x.Code }).ToArrayAsync(ct)
    });

    private static async Task<IResult> ListAsync(AigcHubDbContext db, AccessGrantService grants, CancellationToken ct)
    {
        var result = new List<object>();
        foreach (var x in await db.ManagedMcpServices.AsNoTracking().OrderBy(x => x.Name).ToListAsync(ct))
            result.Add(new { x.Id, x.Name, x.Description, x.Url, x.IsEnabled, x.Revision, x.TimeoutSeconds, x.IconDataUrl,
                x.AuthenticationMode, x.TokenExchangeUrl, x.AssertionAudience, x.TokenResource, x.TokenScopes,
                hasServerSecret = x.SecretProtected.Length > 0, grants = await grants.GetAsync(Resource(x.Id), ct) });
        return Results.Ok(result);
    }

    private static async Task<IResult> SaveAsync(Guid? id, Input input, AigcHubDbContext db, AccessGrantService grants,
        IDataProtectionProvider protection, ICurrentUser current, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 120 || input.Description is null || input.Description.Length > 2000
            || !Uri.TryCreate(input.Url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || input.TimeoutSeconds is < 5 or > 300
            || input.ServerSecret?.Length > 8192 || input.ServerSecret?.IndexOfAny(['\r', '\n']) >= 0 || input.Grants is null
            || input.Grants.UserIds is null || input.Grants.RoleIds is null || input.Grants.DepartmentIds is null)
            return Results.BadRequest("名称、地址、超时或授权配置无效");
        Uri? exchangeUri = null;
        if (input.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange
            && uri.Scheme != "https" && !uri.IsLoopback)
            return Results.BadRequest("员工身份断言模式要求 HTTPS 的 MCP 地址（本机调试可用 http://localhost）");
        if (input.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange
            && (!Uri.TryCreate(input.TokenExchangeUrl, UriKind.Absolute, out exchangeUri)
                || exchangeUri.Scheme != "https" || exchangeUri.UserInfo.Length > 0 || exchangeUri.Fragment.Length > 0
                || string.IsNullOrWhiteSpace(input.AssertionAudience) || input.AssertionAudience.Length > 200
                || string.IsNullOrWhiteSpace(input.TokenResource) || input.TokenResource.Length > 500
                || input.TokenScopes.Length > 1000))
            return Results.BadRequest("用户身份交换需要 HTTPS Token 地址、断言接收方、资源标识和有效 Scope");
        var row = id is null ? new ManagedMcpService() : await db.ManagedMcpServices.FindAsync([id.Value], ct);
        if (row is null) return Results.NotFound();
        // Validate grants before mutating the tracked service; grant updates use the shared authorization service.
        await using var transaction = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        await grants.SetAsync(Resource(row.Id), input.Grants, ct);
        if (id is null) db.ManagedMcpServices.Add(row);
        row.Name = input.Name.Trim(); row.Description = input.Description.Trim(); row.Url = uri.AbsoluteUri;
        row.IsEnabled = input.IsEnabled; row.TimeoutSeconds = input.TimeoutSeconds; row.Revision++;
        row.AuthenticationMode = input.AuthenticationMode;
        row.TokenExchangeUrl = exchangeUri?.AbsoluteUri ?? "";
        row.AssertionAudience = input.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange ? input.AssertionAudience.Trim() : "";
        row.TokenResource = input.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange ? input.TokenResource.Trim() : "";
        row.TokenScopes = input.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange
            ? string.Join(' ', input.TokenScopes.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Distinct()) : "";
        if (input.ClearSecret) row.SecretProtected = "";
        if (!string.IsNullOrWhiteSpace(input.ServerSecret))
            row.SecretProtected = protection.CreateProtector(Purpose(row.Id)).Protect(input.ServerSecret.Trim());
        Audit(db, current.Id, "mcp.publish", row.Id, true);
        await db.SaveChangesAsync(ct);
        if (transaction is not null) await transaction.CommitAsync(ct);
        return Results.Ok(new { row.Id });
    }

    private static async Task<IResult> IconAsync(Guid id, HttpRequest request, AigcHubDbContext db, ICurrentUser current, CancellationToken ct)
    {
        var row = await db.ManagedMcpServices.FindAsync([id], ct);
        if (row is null) return Results.NotFound();
        if (!request.HasFormContentType) return Results.BadRequest("请上传图标");
        var file = (await request.ReadFormAsync(ct)).Files.GetFile("icon");
        if (file is null || file.Length is < 12 or > 512_000) return Results.BadRequest("图标须小于 500 KB");
        using var memory = new MemoryStream(); await file.CopyToAsync(memory, ct); var bytes = memory.ToArray();
        var mime = bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ? "image/png"
            : bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 ? "image/jpeg"
            : bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8) ? "image/webp" : null;
        if (mime is null) return Results.BadRequest("仅支持 PNG、JPEG、WebP 图标");
        row.IconDataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}"; row.Revision++;
        Audit(db, current.Id, "mcp.icon", id, true); await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> PolicyAsync(HttpRequest request, AigcHubDbContext db, AccessGrantService grants, CancellationToken ct)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var user = await DshManagedEndpoints.UserAsync(request, db, ct); if (user is null) return Results.Unauthorized();
        var result = new List<object>();
        foreach (var x in await db.ManagedMcpServices.AsNoTracking().Where(x => x.IsEnabled).OrderBy(x => x.Name).ToListAsync(ct))
            if (await grants.AllowsAsync(Resource(x.Id), user.Id, ct))
            {
                if (x.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange)
                    result.Add(new { x.Id, x.Name, x.Description, x.IconDataUrl, x.Revision, x.TimeoutSeconds,
                        authenticationMode = "user-assertion-exchange", url = x.Url, tokenExchangeUrl = x.TokenExchangeUrl,
                        tokenResource = x.TokenResource, tokenScopes = x.TokenScopes,
                        assertionPath = $"/v1/mcp/{x.Id:D}/identity-assertion" });
                else
                    result.Add(new { x.Id, x.Name, x.Description, x.IconDataUrl, x.Revision, x.TimeoutSeconds,
                        authenticationMode = "gateway-bearer", gatewayPath = $"/v1/mcp/{x.Id:D}/gateway" });
            }
        return Results.Ok(new { userId = user.Id, services = result });
    }

    private static async Task<IResult> AssertionAsync(Guid id, HttpRequest request, AigcHubDbContext db,
        AccessGrantService grants, McpIdentityAssertionIssuer issuer, CancellationToken ct)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var row = await db.ManagedMcpServices.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (row is null || !row.IsEnabled || row.AuthenticationMode != McpAuthenticationMode.UserAssertionExchange
            || !await grants.AllowsAsync(Resource(id), user.Id, ct)) return Results.Forbid();
        var profile = await IdentityQueries.ProfileAsync(db, user.Id, ct);
        if (profile is null) return Results.Unauthorized();
        try
        {
            var result = issuer.Create(profile, row.AssertionAudience);
            Audit(db, user.Id, "mcp.assertion", id, true); await db.SaveChangesAsync(ct);
            return Results.Ok(new { assertion = result.Assertion, expiresAt = result.ExpiresAt });
        }
        catch (InvalidOperationException) { return Results.Problem("MCP 身份断言签名未配置", statusCode: 503); }
    }

    private static HttpRequestMessage Upstream(ManagedMcpService row, string method, IDataProtectionProvider protection)
    {
        var message = new HttpRequestMessage(new HttpMethod(method), row.Url);
        if (row.SecretProtected.Length > 0)
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", protection.CreateProtector(Purpose(row.Id)).Unprotect(row.SecretProtected));
        return message;
    }

    private static async Task GatewayAsync(Guid id, HttpContext context, AigcHubDbContext db, AccessGrantService grants,
        IDataProtectionProvider protection, IHttpClientFactory clients)
    {
        var ct = context.RequestAborted;
        var user = await DshManagedEndpoints.UserAsync(context.Request, db, ct);
        if (user is null) { context.Response.StatusCode = 401; return; }
        var row = await db.ManagedMcpServices.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (row is null || !row.IsEnabled || row.AuthenticationMode != McpAuthenticationMode.GatewayBearer
            || !await grants.AllowsAsync(Resource(id), user.Id, ct)) { context.Response.StatusCode = 403; return; }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(row.TimeoutSeconds));
        using var message = Upstream(row, context.Request.Method, protection);
        var sessionProtector = protection.CreateProtector("AigcHub.Mcp.Session.v1");
        if (context.Request.Headers.TryGetValue("Mcp-Session-Id", out var session)) {
            try {
                var decoded = JsonSerializer.Deserialize<GatewaySession>(sessionProtector.Unprotect(session.ToString()));
                if (decoded is null || decoded.UserId != user.Id || decoded.ServiceId != id || decoded.Revision != row.Revision
                    || decoded.ExpiresAt <= DateTimeOffset.UtcNow) { context.Response.StatusCode = 404; return; }
                message.Headers.TryAddWithoutValidation("Mcp-Session-Id", decoded.UpstreamId);
            } catch (Exception error) when (error is System.Security.Cryptography.CryptographicException or JsonException) { context.Response.StatusCode = 404; return; }
        }
        foreach (var header in new[] { "Accept", "MCP-Protocol-Version", "Last-Event-ID" })
            if (context.Request.Headers.TryGetValue(header, out var value)) message.Headers.TryAddWithoutValidation(header, value.ToArray());
        if (HttpMethods.IsPost(context.Request.Method)) {
            message.Content = new StreamContent(context.Request.Body);
            message.Content.Headers.ContentType = MediaTypeHeaderValue.Parse("application/json");
        }
        try {
            using var response = await clients.CreateClient("mcp-gateway").SendAsync(message, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (response.Headers.TryGetValues("Mcp-Session-Id", out var sessions)) {
                var upstreamSession = sessions.SingleOrDefault();
                if (upstreamSession is null || upstreamSession.Length > 4096) { context.Response.StatusCode = 502; return; }
                context.Response.Headers["Mcp-Session-Id"] = sessionProtector.Protect(JsonSerializer.Serialize(
                    new GatewaySession(user.Id, id, row.Revision, upstreamSession, DateTimeOffset.UtcNow.AddHours(8))));
            }
            context.Response.StatusCode = (int)response.StatusCode;
            context.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
            context.Response.Headers.CacheControl = "no-store"; context.Response.Headers["X-Accel-Buffering"] = "no";
            if (response.Headers.TryGetValues("MCP-Protocol-Version", out var version)) context.Response.Headers["MCP-Protocol-Version"] = version.ToArray();
            await response.Content.CopyToAsync(context.Response.Body, deadline.Token);
            Audit(db, user.Id, "mcp.request", id, response.IsSuccessStatusCode); await db.SaveChangesAsync(ct);
        } catch (Exception error) when (error is HttpRequestException or OperationCanceledException) {
            if (!context.Response.HasStarted && !ct.IsCancellationRequested) context.Response.StatusCode = error is OperationCanceledException ? 504 : 502;
            else context.Abort();
        }
    }

    private static async Task<IResult> TestAsync(Guid id, AigcHubDbContext db, IDataProtectionProvider protection,
        IHttpClientFactory clients, CancellationToken ct)
    {
        var row = await db.ManagedMcpServices.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, ct);
        if (row is null) return Results.NotFound();
        if (row.AuthenticationMode == McpAuthenticationMode.UserAssertionExchange)
            return Results.BadRequest("用户身份交换服务需要使用获授权员工身份进行端到端测试");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(row.TimeoutSeconds));
        using var message = Upstream(row, "POST", protection);
        message.Headers.Accept.ParseAdd("application/json, text/event-stream");
        message.Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/list", @params = new {
            _meta = new Dictionary<string, object> { ["io.modelcontextprotocol/protocolVersion"] = "2026-07-28", ["io.modelcontextprotocol/clientCapabilities"] = new { } }
        }});
        try {
            using var response = await clients.CreateClient("mcp-gateway").SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode || response.Headers.Contains("Mcp-Session-Id")) return Results.BadRequest("服务未通过无会话 Streamable HTTP 工具发现，请核对协议兼容性与认证");
            var result = await ReadToolListAsync(response, timeout.Token);
            if (!result.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array)
                return Results.BadRequest("目标未返回有效的 MCP 工具清单");
            return Results.Ok(new { tools = tools.Clone(), hasMore = result.TryGetProperty("nextCursor", out _), testedAt = DateTimeOffset.UtcNow });
        } catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException) {
            return Results.BadRequest("MCP 连接或工具发现失败，请核对地址、认证和协议版本");
        }
    }


    // Stop at the matching SSE reply rather than waiting for a long-lived response to end.
    private static async Task<JsonElement> ReadToolListAsync(HttpResponseMessage response, CancellationToken ct)
    {
        using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        var chunk = new char[4096]; var buffer = new System.Text.StringBuilder(); var total = 0;
        var sse = response.Content.Headers.ContentType?.MediaType == "text/event-stream";
        while (true) {
            var count = await reader.ReadAsync(chunk, ct); total += count;
            if (total > 128_000) throw new InvalidDataException("MCP tool preview exceeds the size limit");
            buffer.Append(chunk, 0, count);
            if (sse) {
                var remaining = buffer.ToString().Replace("\r\n", "\n");
                int index;
                while ((index = remaining.IndexOf("\n\n", StringComparison.Ordinal)) >= 0) {
                    var frame = remaining[..index]; remaining = remaining[(index + 2)..];
                    var data = string.Join('\n', frame.Split('\n').Where(x => x.StartsWith("data:")).Select(x => x[5..].TrimStart()));
                    if (data.Length == 0) continue;
                    using var document = JsonDocument.Parse(data);
                    if (document.RootElement.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.GetInt32() == 1) {
                        if (!document.RootElement.TryGetProperty("result", out var result)) throw new InvalidDataException("MCP discovery failed");
                        return result.Clone();
                    }
                }
                buffer.Clear(); buffer.Append(remaining);
            }
            if (count == 0) break;
        }
        using var json = JsonDocument.Parse(buffer.ToString());
        if (!json.RootElement.TryGetProperty("result", out var value)) throw new InvalidDataException("MCP discovery failed");
        return value.Clone();
    }

    private sealed record GatewaySession(Guid UserId, Guid ServiceId, long Revision, string UpstreamId, DateTimeOffset ExpiresAt);

    private static void Audit(AigcHubDbContext db, Guid user, string action, Guid id, bool success) =>
        db.OperationAudits.Add(new OperationAudit { UserId = user, Action = action, EntityType = "MCP", EntityId = id.ToString(), Succeeded = success });
}
