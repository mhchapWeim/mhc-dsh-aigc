using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class WebSearchEndpoints
{
    private sealed record SearchConfigurationInput(string? ApiKey, bool IsEnabled, AccessGrantSelection Grants);
    private sealed record SearchInput(string Query);
    private sealed record SearchSource(string Url,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Title,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Snippet,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PublishedAt);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void MapWebSearchEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/web-search").WithTags("DeepSeek 搜索管理").RequireAuthorization("model.manage");
        admin.MapGet("/", GetConfigurationAsync);
        admin.MapPut("/", SaveConfigurationAsync);
        app.MapPost("/v1/web-search", SearchAsync).WithTags("DSH 托管接入");
    }

    private static async Task<IResult> GetConfigurationAsync(AigcHubDbContext db, AccessGrantService grants, CancellationToken ct)
    {
        var config = await db.WebSearchConfigurations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == 1, ct);
        return Results.Ok(new { isEnabled = config?.IsEnabled ?? false,
            hasApiKey = !string.IsNullOrWhiteSpace(config?.ApiKeyProtected),
            grants = await grants.GetAsync(AccessGrantService.WebSearchKey, ct) });
    }

    private static async Task<IResult> SaveConfigurationAsync(SearchConfigurationInput input, AigcHubDbContext db,
        AccessGrantService grants, IDataProtectionProvider protection, ICurrentUser current, CancellationToken ct)
    {
        var config = await db.WebSearchConfigurations.SingleOrDefaultAsync(x => x.Id == 1, ct);
        if (config is null) { config = new WebSearchConfiguration(); db.WebSearchConfigurations.Add(config); }
        if (!string.IsNullOrWhiteSpace(input.ApiKey))
            config.ApiKeyProtected = protection.CreateProtector("AigcHub.DeepSeekWebSearch.v1").Protect(input.ApiKey.Trim());
        if (input.IsEnabled && string.IsNullOrWhiteSpace(config.ApiKeyProtected))
            throw new WorkflowException("启用搜索前必须配置 DeepSeek API Key", 400);
        config.IsEnabled = input.IsEnabled;
        await grants.SetAsync(AccessGrantService.WebSearchKey, input.Grants, ct);
        db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "web-search.configure",
            EntityType = "WebSearch", EntityId = "1", Succeeded = true,
            DetailJson = JsonSerializer.Serialize(new { input.IsEnabled,
                userCount = input.Grants.UserIds.Length, roleCount = input.Grants.RoleIds.Length,
                departmentCount = input.Grants.DepartmentIds.Length }) });
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> SearchAsync(SearchInput input, HttpRequest request, AigcHubDbContext db,
        AccessGrantService grants, IDataProtectionProvider protection, IHttpClientFactory clients, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        if (!await grants.AllowsAsync(AccessGrantService.WebSearchKey, user.Id, ct)) return Results.Forbid();
        var config = await db.WebSearchConfigurations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == 1, ct);
        if (config is null || !config.IsEnabled || string.IsNullOrWhiteSpace(config.ApiKeyProtected))
            return Results.Problem("DeepSeek 搜索未配置或未启用", statusCode: 503);
        var query = input.Query?.Trim();
        if (string.IsNullOrWhiteSpace(query) || query.Length > 1000) return Results.BadRequest("搜索词长度必须为 1-1000 个字符");
        string key;
        try { key = protection.CreateProtector("AigcHub.DeepSeekWebSearch.v1").Unprotect(config.ApiKeyProtected); }
        catch (System.Security.Cryptography.CryptographicException)
        { return Results.Problem("DeepSeek 搜索密钥无法解密，请管理员重新设置", statusCode: 503); }
        using var message = new HttpRequestMessage(HttpMethod.Post, "https://api.deepseek.com/anthropic/v1/messages");
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        message.Headers.Add("x-api-key", key);
        message.Headers.Add("anthropic-version", "2023-06-01");
        message.Content = new StringContent(JsonSerializer.Serialize(new
        {
            model = "deepseek-v4-flash", max_tokens = 4096,
            messages = new[] { new { role = "user", content = new[] { new { type = "text", text = $"Perform a web search for the query: {query}" } } } },
            tools = new[] { new { type = "web_search_20250305", name = "web_search", max_uses = 5 } }
        }, Json), Encoding.UTF8, "application/json");
        var client = clients.CreateClient("deepseek-web-search");
        HttpResponseMessage response;
        try { response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, ct); }
        catch (HttpRequestException) { return Results.Problem("DeepSeek 搜索服务连接失败", statusCode: 502); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        { return Results.Problem("DeepSeek 搜索服务请求超时", statusCode: 504); }
        using (response)
        {
            if (!response.IsSuccessStatusCode) return Results.Problem("DeepSeek 搜索服务调用失败", statusCode: 502);
            JsonDocument document;
            try { document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct); }
            catch (JsonException) { return Results.Problem("DeepSeek 搜索响应格式无效", statusCode: 502); }
            using var ownedDocument = document;
            if (!document.RootElement.TryGetProperty("content", out var blocks) || blocks.ValueKind != JsonValueKind.Array)
                return Results.Problem("DeepSeek 搜索响应格式无效", statusCode: 502);
            var snippets = new Dictionary<string, string>();
            foreach (var block in blocks.EnumerateArray())
            {
                if (Read(block, "type") != "text" || !block.TryGetProperty("citations", out var citations) || citations.ValueKind != JsonValueKind.Array) continue;
                foreach (var citation in citations.EnumerateArray())
                {
                    var url = Read(citation, "url"); var excerpt = Read(citation, "cited_text");
                    if (!string.IsNullOrWhiteSpace(url) && !string.IsNullOrWhiteSpace(excerpt)) snippets.TryAdd(url, excerpt);
                }
            }
            var sources = new List<SearchSource>();
            var seen = new HashSet<string>();
            var foundBlock = false;
            foreach (var block in blocks.EnumerateArray())
            {
                if (Read(block, "type") != "web_search_tool_result") continue;
                foundBlock = true;
                if (!block.TryGetProperty("content", out var entries) || entries.ValueKind != JsonValueKind.Array) continue;
                foreach (var entry in entries.EnumerateArray())
                {
                    var url = Read(entry, "url");
                    if (Read(entry, "type") != "web_search_result" || string.IsNullOrWhiteSpace(url) || !seen.Add(url)) continue;
                    sources.Add(new SearchSource(url, Read(entry, "title"), snippets.GetValueOrDefault(url), Read(entry, "page_age")));
                }
            }
            if (!foundBlock) return Results.Problem("DeepSeek 未返回网页搜索结果", statusCode: 502);
            return Results.Ok(new { sources, truncated = false });
        }
    }

    private static string? Read(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String
            ? field.GetString() : null;
}
