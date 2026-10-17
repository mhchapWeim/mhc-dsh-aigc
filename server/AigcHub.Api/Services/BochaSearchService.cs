using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public static class BochaSearchService
{
    public sealed record Input(string Query, int MaxResults = 8);
    public static async Task<IResult> SearchAsync(Input input, HttpRequest request, AigcHubDbContext db,
        AccessGrantService grants, IDataProtectionProvider protection, IHttpClientFactory clients, IConfiguration configuration, CancellationToken ct)
    {
        var user = await DshManagedEndpoints.UserAsync(request, db, ct);
        if (user is null) return Results.Unauthorized();
        var plugin = await db.ManagedPlugins.AsNoTracking().SingleOrDefaultAsync(x => x.PackageName == PluginMarketEndpoints.SearchPackage, ct);
        if (plugin is null || !plugin.IsEnabled || plugin.PublishedVersionId is null
            || !await grants.AllowsAsync(PluginMarketEndpoints.Resource(plugin.Id), user.Id, ct))
            return Results.Problem("网页搜索插件未启用或当前用户未获授权", statusCode: 403);
        if (string.IsNullOrWhiteSpace(input.Query) || input.Query.Length > 1000 || input.MaxResults is < 1 or > 50)
            return Results.BadRequest("搜索词须为 1-1000 个字符，结果数量须为 1-50");
        string key;
        try { key = protection.CreateProtector(PluginMarketEndpoints.SecretPurpose(plugin.Id)).Unprotect(plugin.ServerSecretProtected); }
        catch (CryptographicException) { return Results.Problem("博查密钥无法解密，请管理员重新配置", statusCode: 503); }
        var endpoint = configuration["BochaSearch:Endpoint"] ?? "https://api.bochaai.com/v1/web-search";
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment) || !string.IsNullOrEmpty(uri.Query))
            return Results.Problem("博查搜索服务地址配置无效，须为 HTTPS 地址", statusCode: 503);
        using var message = new HttpRequestMessage(HttpMethod.Post, uri);
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        message.Content = JsonContent.Create(new { query = input.Query.Trim(), count = input.MaxResults, summary = true, freshness = "noLimit" });
        try
        {
            using var response = await clients.CreateClient("bocha-web-search").SendAsync(message, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode) return Results.Problem("博查搜索调用失败", statusCode: response.StatusCode == System.Net.HttpStatusCode.TooManyRequests ? 429 : 502);
            await response.Content.LoadIntoBufferAsync(4 * 1024 * 1024, ct);
            using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            return Results.Ok(Map(json.RootElement, input.MaxResults));
        }
        catch (HttpRequestException) { return Results.Problem("博查搜索连接失败", statusCode: 502); }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested) { return Results.Problem("博查搜索超时", statusCode: 504); }
        catch (JsonException) { return Results.Problem("博查搜索响应无效", statusCode: 502); }
        catch (InvalidDataException) { return Results.Problem("博查搜索响应无效", statusCode: 502); }
    }

    public sealed record Source(string Url, string? Title, string? Snippet, string? PublishedAt);
    public sealed record SearchResult(Source[] Sources, bool Truncated);
    public static SearchResult Map(JsonElement root, int maxResults)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Bocha returned an invalid search result");
        // Accept the documented SearchResponse and the legacy code/data envelope.
        var data = root;
        if (root.TryGetProperty("code", out var code))
        {
            if (code.ValueKind != JsonValueKind.Number || !code.TryGetInt32(out var value) || value != 200
                || !root.TryGetProperty("data", out data)) throw new InvalidDataException("Bocha returned an invalid search result");
        }
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("webPages", out var pages)
            || pages.ValueKind != JsonValueKind.Object || !pages.TryGetProperty("value", out var entries)
            || entries.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Bocha returned an invalid search result");
        var sources = new List<Source>(); var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in entries.EnumerateArray())
        {
            var url = Read(entry, "url");
            if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || !seen.Add(url)) continue;
            sources.Add(new(url, Read(entry, "name"), Read(entry, "summary") ?? Read(entry, "snippet"), Read(entry, "datePublished")));
        }
        return new(sources.Take(maxResults).ToArray(), sources.Count > maxResults);
    }
    private static string? Read(JsonElement element, string key) => element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
        && !string.IsNullOrWhiteSpace(value.GetString()) ? value.GetString() : null;
}
