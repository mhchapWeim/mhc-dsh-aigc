using System.Net.Http.Headers;
using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

public sealed record LiteLlmModelSyncResult(int Discovered, int Created, int Updated, int Disabled);

public sealed class LiteLlmOptions
{
    public string BaseUrl { get; set; } = "";
    public string PublicBaseUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string ManagementApiKey { get; set; } = "";
    public bool VerifySsl { get; set; } = true;
    public int TimeoutSeconds { get; set; } = 20;
}

public sealed class LiteLlmModelSyncService(
    AigcHubDbContext db,
    IDataProtectionProvider protectionProvider,
    IHttpClientFactory clients,
    IOptions<LiteLlmOptions> options)
{
    private readonly IDataProtector _protector = protectionProvider.CreateProtector("AigcHub.ModelApiKeys.v1");

    public async Task<LiteLlmModelSyncResult> SynchronizeAsync(CancellationToken ct)
    {
        if (!Uri.TryCreate(options.Value.BaseUrl?.Trim(), UriKind.Absolute, out var baseUri)
            || (baseUri.Scheme != Uri.UriSchemeHttp && baseUri.Scheme != Uri.UriSchemeHttps))
            throw new WorkflowException("后端未配置有效的 LiteLLM:BaseUrl");
        if (!string.IsNullOrEmpty(baseUri.Query) || !string.IsNullOrEmpty(baseUri.Fragment))
            throw new WorkflowException("LiteLLM Base URL 不能包含查询参数或片段");

        var baseUrl = options.Value.BaseUrl.Trim().TrimEnd('/');
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/models");
        var apiKey = options.Value.ApiKey?.Trim() ?? "";
        if (apiKey.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        HttpResponseMessage response;
        try
        {
            response = await clients.CreateClient("litellm-model-sync").SendAsync(request,
                HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            throw new WorkflowException("无法连接 LiteLLM 模型目录", 502);
        }
        using (response)
        {
        if (!response.IsSuccessStatusCode)
            throw new WorkflowException($"LiteLLM 模型目录请求失败（{(int)response.StatusCode}）", 502);

        JsonDocument document;
        try { document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct); }
        catch (JsonException) { throw new WorkflowException("LiteLLM 模型目录返回了无效 JSON", 502); }
        using (document)
        {
            if (!document.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
                throw new WorkflowException("LiteLLM 模型目录缺少 data 数组", 502);
            if (data.GetArrayLength() > 1000) throw new WorkflowException("LiteLLM 模型目录超过 1000 项上限", 502);

            var identifiers = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in data.EnumerateArray())
            {
                if (!item.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.String)
                    throw new WorkflowException("LiteLLM 模型目录包含无效模型标识", 502);
                var id = idValue.GetString()?.Trim() ?? "";
                if (id.Length is 0 or > 200) throw new WorkflowException("LiteLLM 模型标识必须为 1 到 200 个字符", 502);
                identifiers.Add(id);
            }

            var models = await db.ModelConfigurations.Where(x => x.ProviderKind == "LiteLLM").ToListAsync(ct);
            if (models.GroupBy(x => x.ModelIdentifier, StringComparer.Ordinal).Any(group => group.Count() > 1))
                throw new WorkflowException("AIGC 中存在重复的 LiteLLM 模型标识，请先合并重复配置", 409);
            foreach (var model in models)
            {
                model.BaseUrl = baseUrl;
                model.ApiKeyProtected = apiKey.Length == 0 ? "" : _protector.Protect(apiKey);
                model.AuthType = apiKey.Length == 0 ? "None" : "Bearer";
            }
            var byIdentifier = models.ToDictionary(x => x.ModelIdentifier, StringComparer.Ordinal);
            var occupiedNames = await db.ModelConfigurations.Select(x => x.Name).ToHashSetAsync(ct);
            var created = 0;
            var updated = 0;
            foreach (var identifier in identifiers.Order(StringComparer.Ordinal))
            {
                if (byIdentifier.TryGetValue(identifier, out var existing))
                {
                    existing.EndpointPath = "/chat/completions";
                    existing.UpdatedAt = DateTimeOffset.UtcNow;
                    updated++;
                    continue;
                }

                var name = UniqueName($"LiteLLM · {identifier}", occupiedNames);
                occupiedNames.Add(name);
                db.ModelConfigurations.Add(new AiModelConfiguration
                {
                    Name = name,
                    ProviderKind = "LiteLLM",
                    BaseUrl = baseUrl,
                    EndpointPath = "/chat/completions",
                    ModelIdentifier = identifier,
                    ApiKeyProtected = apiKey.Length == 0 ? "" : _protector.Protect(apiKey),
                    AuthType = apiKey.Length == 0 ? "None" : "Bearer",
                    SupportsTools = true,
                    IsEnabled = false,
                    IsDefault = false
                });
                created++;
            }

            var disabled = 0;
            foreach (var missing in models.Where(x => !identifiers.Contains(x.ModelIdentifier) && x.IsEnabled))
            {
                missing.IsEnabled = false;
                missing.IsDefault = false;
                missing.UpdatedAt = DateTimeOffset.UtcNow;
                disabled++;
            }
            await db.SaveChangesAsync(ct);
            return new LiteLlmModelSyncResult(identifiers.Count, created, updated, disabled);
        }
        }
    }

    private static string UniqueName(string preferred, HashSet<string> occupied)
    {
        if (!occupied.Contains(preferred)) return preferred;
        for (var suffix = 2; ; suffix++)
        {
            var candidate = $"{preferred} ({suffix})";
            if (!occupied.Contains(candidate)) return candidate;
        }
    }
}
