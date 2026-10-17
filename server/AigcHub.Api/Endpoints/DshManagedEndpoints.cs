using System.Net.Http.Headers;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class DshManagedEndpoints
{
    private sealed record LoginInput(string Username, string Password);
    /// <summary>One catalog entry; capacities are omitted when LiteLLM does not disclose them.</summary>
    private sealed record DshModelView(string Id, string Name, string[] Input,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? ContextWindow,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? MaxOutputTokens);
    private const string CasDeviceCookie = "aigc-cas-device";

    public static void MapDshManagedEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/v1").WithTags("DSH 托管接入");
        group.MapPost("/auth/login", LoginAsync);
        group.MapPost("/auth/refresh", RefreshAsync);
        group.MapGet("/auth/cas/config", CasConfigAsync);
        group.MapPost("/auth/cas/device", CasDeviceAsync);
        group.MapGet("/auth/cas/device/{deviceCode}", CasDeviceStatusAsync);
        group.MapGet("/auth/cas/start", CasStartAsync);
        group.MapGet("/auth/cas/callback", CasCallbackAsync);
        group.MapGet("/auth/me", MeAsync);
        group.MapPost("/auth/logout", LogoutAsync);
        group.MapGet("/models", ModelsAsync);
        group.MapGet("/plugins/internal-model/models", InternalModelsAsync);
        group.MapGet("/plugins/internal-model/models/{id:guid}/connection", InternalConnectionAsync);
        group.MapPost("/generate", GenerateAsync);
    }

    private static string? Token(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal)) return null;
        var token = header[7..];
        return token.Length == 64 && token.All(Uri.IsHexDigit) ? token : null;
    }

    private static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token)));

    internal static async Task<AppUser?> UserAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var token = Token(request);
        if (token is null) return null;
        var hash = Hash(token);
        var now = DateTimeOffset.UtcNow;
        var user = await db.DshAccessTokens.AsNoTracking().Where(x => x.TokenHash == hash && x.ExpiresAt > now && x.User.IsEnabled
            && (x.PersistentSessionId == null || db.DshPersistentSessions.Any(s => s.Id == x.PersistentSessionId && !s.Revoked)))
            .Select(x => x.User).SingleOrDefaultAsync(ct);
        if (user is not null) RequestLoggingMiddleware.Identify(request.HttpContext, user.Id, user.EmployeeNo, user.Name);
        return user;
    }

    private static async Task<IResult> LoginAsync(LoginInput input, AigcHubDbContext db,
        IPasswordHasher<AppUser> hasher, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("DshManagedAuthentication");
        var username = input.Username.Trim().ToLowerInvariant();
        var user = await db.Users.SingleOrDefaultAsync(x => x.EmployeeNo.ToLower() == username && x.IsEnabled, ct);
        if (user is null || hasher.VerifyHashedPassword(user, user.PasswordHash, input.Password) == PasswordVerificationResult.Failed)
        {
            logger.LogWarning("DSH password login rejected username={Username}", username);
            return Results.Unauthorized();
        }
        var login = await IssueTokenAsync(user, db, ct);
        logger.LogInformation("DSH password login completed user={UserId} username={Username}", user.Id, user.EmployeeNo);
        return Results.Ok(login);
    }

    private static IResult CasConfigAsync(IOptions<CasOptions> configured)
    {
        var options = configured.Value;
        if (!options.Enabled) return Results.Ok(new { enabled = false });
        if (!Uri.TryCreate(options.LoginUrl, UriKind.Absolute, out _)
            || !Uri.TryCreate(options.LogoutUrl, UriKind.Absolute, out _)
            || !Uri.TryCreate(options.ValidateUrl, UriKind.Absolute, out _)
            || !Uri.TryCreate(options.ServiceUrl, UriKind.Absolute, out _))
            return Results.Problem("CAS 配置中的 LoginUrl、LogoutUrl、ValidateUrl 和 ServiceUrl 必须是绝对 URL", statusCode: 500);
        var separator = options.LoginUrl.Contains('?') ? "&" : "?";
        var logoutSeparator = options.LogoutUrl.Contains('?') ? "&" : "?";
        return Results.Ok(new
        {
            enabled = true,
            login_url = $"{options.LoginUrl}{separator}service={Uri.EscapeDataString(options.ServiceUrl)}",
            logout_url = $"{options.LogoutUrl}{logoutSeparator}service={Uri.EscapeDataString(options.ServiceUrl)}",
            service = options.ServiceUrl
        });
    }

    private static IResult CasDeviceAsync(HttpRequest request, CasDeviceLoginStore logins,
        IOptions<CasOptions> configured)
    {
        var options = configured.Value;
        if (!options.Enabled) return Results.NotFound();
        var code = logins.Create();
        var origin = string.IsNullOrWhiteSpace(options.PublicBaseUrl)
            ? $"{request.Scheme}://{request.Host}"
            : options.PublicBaseUrl.TrimEnd('/');
        return Results.Ok(new
        {
            device_code = code,
            browser_url = $"{origin}/v1/auth/cas/start?device_code={Uri.EscapeDataString(code)}",
            expires_in = 300,
            interval = 2
        });
    }

    private static IResult CasDeviceStatusAsync(string deviceCode, CasDeviceLoginStore logins)
    {
        var token = logins.ReadResult(deviceCode, out var pending);
        if (pending) return Results.Json(new { status = "pending" }, statusCode: StatusCodes.Status202Accepted);
        return token is null ? Results.NotFound() : Results.Ok(token);
    }

    private static IResult CasStartAsync([FromQuery(Name = "device_code")] string deviceCode,
        HttpRequest request, HttpResponse response,
        CasDeviceLoginStore logins, IOptions<CasOptions> configured)
    {
        var options = configured.Value;
        if (!options.Enabled || !logins.Exists(deviceCode)) return Results.BadRequest("登录请求已失效，请返回 DSH 重试。");
        PortalSsoFlow.Clear(response);
        response.Cookies.Append(CasDeviceCookie, deviceCode, new CookieOptions
        {
            HttpOnly = true,
            Secure = request.IsHttps,
            SameSite = SameSiteMode.Lax,
            MaxAge = TimeSpan.FromMinutes(5),
            Path = "/v1/auth/cas"
        });
        var separator = options.LoginUrl.Contains('?') ? "&" : "?";
        return Results.Redirect($"{options.LoginUrl}{separator}service={Uri.EscapeDataString(options.ServiceUrl)}");
    }

    private static async Task<IResult> CasCallbackAsync(string ticket, HttpRequest request,
        HttpResponse response, AigcHubDbContext db,
        CasDeviceLoginStore logins, IOptions<CasOptions> configured,
        ILoggerFactory loggerFactory, PortalSsoFlow portalFlow, CasAuthenticationService cas, CancellationToken ct)
    {
        if (request.Query.TryGetValue("portal_state", out var portalState))
            return await PortalSsoEndpoints.CallbackAsync(ticket, portalState.ToString(), request, response,
                portalFlow, cas, db, loggerFactory, ct);
        var logger = loggerFactory.CreateLogger("DshManagedAuthentication");
        response.Cookies.Delete(CasDeviceCookie, new CookieOptions { Path = "/v1/auth/cas" });
        if (!request.Cookies.TryGetValue(CasDeviceCookie, out var deviceCode)
            || !logins.Exists(deviceCode)) return Results.BadRequest("登录请求已失效，请返回 DSH 重试。");
        var identity = await cas.ValidateAsync(ticket, configured.Value.ServiceUrl, ct);
        if (identity is null)
        {
            logger.LogWarning("DSH CAS callback validation failed request={RequestId}", request.HttpContext.TraceIdentifier);
            return Results.Unauthorized();
        }
        var user = await cas.FindOrCreateUserAsync(identity, ct);
        if (!user.IsEnabled) return Results.Unauthorized();
        var login = await IssueTokenAsync(user, db, ct);
        logger.LogInformation("DSH CAS login completed user={UserId} username={Username}", user.Id, user.EmployeeNo);
        if (!logins.Complete(deviceCode, login)) return Results.BadRequest("登录请求已失效，请返回 DSH 重试。");
        return Results.Content("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>登录成功</title><body style=\"font-family:system-ui;text-align:center;padding:12vh 24px\"><h1>登录成功</h1><p>可以关闭此页面并返回 DSH。</p></body></html>", "text/html; charset=utf-8");
    }

    private static async Task<DshLoginResult> IssueTokenAsync(AppUser user, AigcHubDbContext db, CancellationToken ct)
    {
        var refreshToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var session = new DshPersistentSession { UserId = user.Id, RefreshTokenHash = Hash(refreshToken) };
        db.DshPersistentSessions.Add(session);
        user.LastLoginAt = DateTimeOffset.UtcNow;
        return await IssueAccessAsync(user, session.Id, refreshToken, db, ct);
    }

    private static async Task<DshLoginResult> IssueAccessAsync(AppUser user, Guid sessionId, string refreshToken, AigcHubDbContext db, CancellationToken ct)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var expiresAt = DateTimeOffset.UtcNow.AddHours(8);
        db.DshAccessTokens.Add(new DshAccessToken
        {
            TokenHash = Hash(token), UserId = user.Id, ExpiresAt = expiresAt, PersistentSessionId = sessionId
        });
        await db.SaveChangesAsync(ct);
        return new DshLoginResult(token, refreshToken, expiresAt, new DshLoginUser(user.Id, user.EmployeeNo));
    }

    private static async Task<IResult> RefreshAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var token = Token(request);
        if (token is null) return Results.Unauthorized();
        var hash = Hash(token);
        var session = await db.DshPersistentSessions.SingleOrDefaultAsync(x => x.RefreshTokenHash == hash && !x.Revoked, ct);
        if (session is null) return Results.Unauthorized();
        var user = await db.Users.SingleOrDefaultAsync(x => x.Id == session.UserId && x.IsEnabled, ct);
        if (user is null) return Results.Unauthorized();
        db.DshAccessTokens.RemoveRange(await db.DshAccessTokens.Where(x => x.PersistentSessionId == session.Id && x.ExpiresAt <= DateTimeOffset.UtcNow).ToArrayAsync(ct));
        return Results.Ok(await IssueAccessAsync(user, session.Id, token, db, ct));
    }

    private static async Task<IResult> MeAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var user = await UserAsync(request, db, ct);
        return user is null ? Results.Unauthorized() : Results.Ok(new { user = new { id = user.Id, username = user.EmployeeNo } });
    }

    private static async Task<IResult> LogoutAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        var token = Token(request);
        if (token is null) return Results.Unauthorized();
        var hash = Hash(token);
        var access = await db.DshAccessTokens.SingleOrDefaultAsync(x => x.TokenHash == hash, ct);
        var sessionId = access?.PersistentSessionId;
        var session = await db.DshPersistentSessions.SingleOrDefaultAsync(x => x.RefreshTokenHash == hash || x.Id == sessionId, ct);
        if (session is not null) session.Revoked = true;
        if (access is not null) db.DshAccessTokens.Remove(access);
        await db.SaveChangesAsync(ct);
        return Results.Ok(new { ok = true });
    }

    private static async Task<IResult> ModelsAsync(HttpRequest request, AigcHubDbContext db,
        ModelConfigurationService models, LiteLlmVirtualKeyService virtualKeys, AccessGrantService grants, CancellationToken ct)
    {
        var user = await UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var granted = await models.AvailableAsync(user.Id, ct);
        var additionalModels = await InternalPluginAllowedAsync(user.Id, db, grants, ct)
            ? granted.Where(x => x.ProviderKind == "Local").Select(x => new {
                id = x.Id.ToString("D"), x.Name, provider = "managed-internal" }).ToArray() : [];
        var available = granted.Where(x => x.ProviderKind == "LiteLLM").ToArray();
        var identifiers = available.Select(x => x.ModelIdentifier).Distinct(StringComparer.Ordinal).ToArray();
        if (identifiers.Length == 0) return Results.Ok(new { models = Array.Empty<object>(), additionalModels });
        var capabilities = await virtualKeys.CapabilitiesAsync(ct);
        LiteLlmSessionCredential credential;
        try { credential = await virtualKeys.GetAsync(user.Id, ct); }
        catch (WorkflowException exception) when (exception.StatusCode is 403 or 409 || (exception.StatusCode == 503 && additionalModels.Length > 0))
        {
            // Identity remains valid even when an administrator has not yet assigned a key.
            return Results.Ok(new { models = Array.Empty<object>(), additionalModels, notice = exception.Message });
        }
        return Results.Ok(new
        {
            additionalModels,
            connection = new
            {
                api = "openai-completions",
                baseURL = credential.BaseUrl,
                apiKey = credential.ApiKey,
                expiresAt = credential.ExpiresAt
            },
            models = available.Select(x =>
            {
                capabilities.TryGetValue(x.ModelIdentifier, out var capability);
                return new DshModelView(x.ModelIdentifier, x.Name,
                    capability?.SupportsVision == true ? new[] { "text", "image" } : new[] { "text" },
                    capability?.ContextWindow, capability?.MaxOutputTokens);
            }).ToArray()
        });
    }

    public const string InternalModelPackage = "@bhss/dsh-plugin-internal-model";

    private static async Task<bool> InternalPluginAllowedAsync(Guid userId, AigcHubDbContext db,
        AccessGrantService grants, CancellationToken ct)
    {
        var plugin = await db.ManagedPlugins.AsNoTracking().SingleOrDefaultAsync(
            x => x.PackageName == InternalModelPackage, ct);
        return plugin is { IsEnabled: true, PublishedVersionId: not null }
            && await grants.AllowsAsync(PluginMarketEndpoints.Resource(plugin.Id), userId, ct);
    }

    private static async Task<IResult> InternalModelsAsync(HttpRequest request, AigcHubDbContext db,
        ModelConfigurationService models, AccessGrantService grants, CancellationToken ct)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var user = await UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (!await InternalPluginAllowedAsync(user.Id, db, grants, ct)) return Results.StatusCode(403);
        var available = await models.AvailableAsync(user.Id, ct);
        return Results.Ok(new { models = available.Where(x => x.ProviderKind == "Local")
            .Select(x => new { id = x.Id.ToString("D"), x.Name, input = new[] { "text" }, x.SupportsTools }).ToArray() });
    }

    private static async Task<IResult> InternalConnectionAsync(Guid id, HttpRequest request, AigcHubDbContext db,
        ModelConfigurationService models, AccessGrantService grants, CancellationToken ct)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var user = await UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (!await InternalPluginAllowedAsync(user.Id, db, grants, ct)) return Results.StatusCode(403);
        ResolvedChatModel? model;
        try { model = await models.ResolveGrantedAsync(user.Id, id, ct); }
        catch (WorkflowException exception) { return Results.Problem(exception.Message, statusCode: exception.StatusCode); }
        if (model is null || model.ProviderKind != "Local") return Results.NotFound();
        // The OpenAI completions adapter appends this protocol path itself.
        var endpoint = $"{model.BaseUrl.TrimEnd('/')}/{model.EndpointPath.TrimStart('/')}";
        const string suffix = "/chat/completions";
        if (!endpoint.EndsWith(suffix, StringComparison.Ordinal))
            return Results.Problem("内网插件需要兼容 OpenAI 的 /chat/completions 接口", statusCode: 422);
        return Results.Ok(new { modelIdentifier = model.ModelIdentifier, baseURL = endpoint[..^suffix.Length],
            apiKey = model.ApiKey, model.AuthType, model.ApiKeyHeader, model.SupportsTools,
            model.Temperature, model.MaxTokens, model.TimeoutSeconds });
    }

    private static async Task<IResult> GenerateAsync(HttpRequest request, AigcHubDbContext db,
        ModelConfigurationService models, IHttpClientFactory clients,
        ILoggerFactory loggerFactory, CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("DshManagedGeneration");
        var requestId = request.HttpContext.TraceIdentifier;
        var elapsed = Stopwatch.StartNew();
        var user = await UserAsync(request, db, ct);
        if (user is null)
        {
            logger.LogWarning("DSH generation rejected: unauthenticated request {RequestId}", requestId);
            return Results.Unauthorized();
        }
        if (request.ContentLength is > 2_000_000) return Results.StatusCode(413);
        JsonDocument document;
        try { document = await JsonDocument.ParseAsync(request.Body, cancellationToken: ct); }
        catch (JsonException) { return Results.BadRequest(new { error = "invalid JSON" }); }
        using (document)
        {
            var options = document.RootElement;
            if (options.ValueKind != JsonValueKind.Object || !options.TryGetProperty("model", out var selected)
                || selected.ValueKind != JsonValueKind.String || !Guid.TryParse(selected.GetString(), out var modelId))
                return Results.BadRequest(new { error = "invalid model" });
            ResolvedChatModel? model;
            try { model = await models.ResolveGrantedAsync(user.Id, modelId, ct); }
            catch (WorkflowException exception) when (exception.StatusCode == 403) { return Results.StatusCode(403); }
            catch (WorkflowException exception) when (exception.StatusCode == 404) { return Results.NotFound(); }
            if (model is null) return Results.NotFound();
            object payload;
            try { payload = Payload(model, options); }
            catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or KeyNotFoundException)
            { return Results.UnprocessableEntity(new { error = "invalid generation payload" }); }
            using var outbound = new HttpRequestMessage(HttpMethod.Post,
                $"{model.BaseUrl.TrimEnd('/')}/{model.EndpointPath.TrimStart('/')}");
            if (!string.IsNullOrWhiteSpace(model.ApiKey))
            {
                if (model.AuthType == "Bearer") outbound.Headers.Authorization = new AuthenticationHeaderValue("Bearer", model.ApiKey);
                else if (model.AuthType == "Header") outbound.Headers.TryAddWithoutValidation(model.ApiKeyHeader, model.ApiKey);
            }
            outbound.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            using var client = clients.CreateClient(model.ProviderKind == "LiteLLM"
                ? "dsh-managed-upstream-litellm" : "dsh-managed-upstream");
            client.Timeout = TimeSpan.FromSeconds(Math.Clamp(model.TimeoutSeconds, 10, 300));
            logger.LogInformation("DSH generation started {RequestId} user={UserId} model={ModelId} upstreamModel={UpstreamModel}",
                requestId, user.Id, modelId, model.ModelIdentifier);
            try
            {
                using var response = await client.SendAsync(outbound, ct);
                var raw = await response.Content.ReadAsStringAsync(ct);
                if (!response.IsSuccessStatusCode)
                {
                    var status = (int)response.StatusCode;
                    var mapped = status == 429 ? 429 : status == 503 ? 503 : 502;
                    logger.LogWarning("DSH generation upstream rejected {RequestId} user={UserId} model={ModelId} upstreamStatus={UpstreamStatus} elapsedMs={ElapsedMs} detail={Detail}",
                        requestId, user.Id, modelId, status, elapsed.ElapsedMilliseconds, SafeUpstreamDetail(raw));
                    return Results.Problem(
                        title: mapped == 429 ? "模型服务请求过多" : "模型上游请求失败",
                        detail: mapped == 429 ? "模型服务当前繁忙，请稍后重试。" : "模型服务暂时不可用。",
                        statusCode: mapped,
                        extensions: new Dictionary<string, object?> { ["code"] = status == 429 ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_REJECTED", ["requestId"] = requestId });
                }
                using var upstream = JsonDocument.Parse(raw);
                logger.LogInformation("DSH generation completed {RequestId} user={UserId} model={ModelId} elapsedMs={ElapsedMs}",
                    requestId, user.Id, modelId, elapsed.ElapsedMilliseconds);
                return Results.Text(Chunks(upstream.RootElement), "application/x-ndjson", Encoding.UTF8);
            }
            catch (TaskCanceledException exception) when (!ct.IsCancellationRequested)
            {
                logger.LogError(exception, "DSH generation timed out {RequestId} user={UserId} model={ModelId} elapsedMs={ElapsedMs}",
                    requestId, user.Id, modelId, elapsed.ElapsedMilliseconds);
                return Results.Problem(title: "模型服务响应超时", detail: "模型服务未在限定时间内响应。", statusCode: 504,
                    extensions: new Dictionary<string, object?> { ["code"] = "UPSTREAM_TIMEOUT", ["requestId"] = requestId });
            }
            catch (Exception exception) when (exception is HttpRequestException or JsonException or InvalidOperationException)
            {
                logger.LogError(exception, "DSH generation failed {RequestId} user={UserId} model={ModelId} elapsedMs={ElapsedMs}",
                    requestId, user.Id, modelId, elapsed.ElapsedMilliseconds);
                return Results.Problem(title: "模型上游响应无效或不可用", detail: "模型服务暂时不可用。", statusCode: 502,
                    extensions: new Dictionary<string, object?> { ["code"] = "UPSTREAM_FAILURE", ["requestId"] = requestId });
            }
        }
    }

    private static string SafeUpstreamDetail(string raw)
    {
        var singleLine = raw.Replace('\r', ' ').Replace('\n', ' ').Trim();
        var redacted = Regex.Replace(singleLine, "(?i)(bearer\\s+)[^\\s\\\"]+", "$1[redacted]");
        redacted = Regex.Replace(redacted, "(?i)(api[_-]?key|authorization)(\\\"?\\s*[:=]\\s*\\\"?)[^\\s,}\\\"]+", "$1$2[redacted]");
        redacted = Regex.Replace(redacted, "(?i)\\bsk-[a-z0-9_-]+", "[redacted]");
        return redacted.Length <= 500 ? redacted : redacted[..500];
    }

    private static object Payload(ResolvedChatModel model, JsonElement options)
    {
        var messages = new List<object>();
        if (options.TryGetProperty("system", out var system) && system.ValueKind == JsonValueKind.String)
            messages.Add(new { role = "system", content = system.GetString() });
        if (!options.TryGetProperty("messages", out var source) || source.ValueKind != JsonValueKind.Array)
            throw new ArgumentException("messages must be an array");
        foreach (var entry in source.EnumerateArray())
        {
            if (!entry.TryGetProperty("role", out var roleValue) || roleValue.ValueKind != JsonValueKind.String
                || !entry.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
                throw new ArgumentException("invalid message");
            var role = roleValue.GetString();
            if (role is not ("system" or "user" or "assistant")) throw new ArgumentException("invalid role");
            var text = new List<string>();
            var calls = new List<object>();
            foreach (var block in content.EnumerateArray())
            {
                if (!block.TryGetProperty("type", out var kind)) throw new ArgumentException("invalid content block");
                switch (kind.GetString())
                {
                    case "text": case "reasoning":
                        text.Add(block.GetProperty("text").GetString() ?? "");
                        break;
                    case "tool-call" when role == "assistant":
                        calls.Add(new { id = block.GetProperty("id").GetString(), type = "function", function = new
                        { name = block.GetProperty("name").GetString(), arguments = block.GetProperty("arguments").GetString() } });
                        break;
                    case "tool-result" when role == "user":
                        var result = block.GetProperty("content").EnumerateArray()
                            .Select(x => x.GetProperty("text").GetString() ?? "");
                        messages.Add(new { role = "tool", tool_call_id = block.GetProperty("toolCallId").GetString(), content = string.Join("\n", result) });
                        break;
                    default: throw new ArgumentException("unsupported content block");
                }
            }
            if (!content.EnumerateArray().Any(x => x.GetProperty("type").GetString() == "tool-result"))
                messages.Add(new { role, content = string.Join("\n", text), tool_calls = calls.Count == 0 ? null : calls });
        }
        var payload = new Dictionary<string, object?>
        {
            ["model"] = model.ModelIdentifier, ["messages"] = messages, ["stream"] = false,
            ["temperature"] = options.TryGetProperty("temperature", out var temperature) ? temperature : model.Temperature,
        };
        if (options.TryGetProperty("maxTokens", out var maxTokens)) payload["max_tokens"] = maxTokens;
        else if (model.MaxTokens.HasValue) payload["max_tokens"] = model.MaxTokens.Value;
        if (options.TryGetProperty("stop", out var stop)) payload["stop"] = stop;
        if (options.TryGetProperty("tools", out var tools) && tools.ValueKind == JsonValueKind.Array)
        {
            if (!model.SupportsTools) throw new ArgumentException("model does not support tools");
            payload["tools"] = tools.EnumerateArray().Select(x => new { type = "function", function = new
            { name = x.GetProperty("name").GetString(), description = x.GetProperty("description").GetString(), parameters = x.GetProperty("parameters") } }).ToArray();
        }
        return payload;
    }

    private static string Chunks(JsonElement upstream)
    {
        var choice = upstream.GetProperty("choices")[0];
        var message = choice.GetProperty("message");
        var lines = new List<object>();
        var index = 0;
        foreach (var (field, kind) in new[] { ("content", "text"), ("reasoning_content", "reasoning") })
        {
            if (!message.TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(value.GetString())) continue;
            var content = value.GetString()!;
            lines.Add(new { type = "block-start", index, blockType = kind });
            lines.Add(new { type = kind == "text" ? "text-delta" : "reasoning-delta", index, text = content });
            lines.Add(new { type = "block-end", index, block = new { type = kind, text = content } });
            index++;
        }
        if (message.TryGetProperty("tool_calls", out var calls) && calls.ValueKind == JsonValueKind.Array)
            foreach (var call in calls.EnumerateArray())
            {
                var function = call.GetProperty("function");
                var id = call.GetProperty("id").GetString();
                var name = function.GetProperty("name").GetString();
                var arguments = function.GetProperty("arguments").GetString();
                lines.Add(new { type = "block-start", index, blockType = "tool-call" });
                lines.Add(new { type = "tool-call-delta", index, id, name, argumentsDelta = arguments });
                lines.Add(new { type = "block-end", index, block = new { type = "tool-call", id, name, arguments } });
                index++;
            }
        if (upstream.TryGetProperty("usage", out var usage) && usage.TryGetProperty("prompt_tokens", out var input)
            && usage.TryGetProperty("completion_tokens", out var output))
            lines.Add(new { type = "usage", usage = new { inputTokens = input.GetInt32(), outputTokens = output.GetInt32(), totalTokens = input.GetInt32() + output.GetInt32() } });
        var reason = choice.TryGetProperty("finish_reason", out var finish) ? finish.GetString() : null;
        lines.Add(new { type = "finish", reason = new { kind = reason == "tool_calls" ? "tool-calls" : reason == "length" ? "max-tokens" : "stop" } });
        return string.Join("\n", lines.Select(line => JsonSerializer.Serialize(line))) + "\n";
    }
}
