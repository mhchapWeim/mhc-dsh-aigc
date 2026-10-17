using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

public sealed record LiteLlmSessionCredential(string BaseUrl, string ApiKey, DateTimeOffset? ExpiresAt);

/// <summary>Capabilities LiteLLM reports for one model name; a field is absent when LiteLLM does not disclose it.</summary>
public sealed record LiteLlmModelCapability(bool SupportsVision, int? ContextWindow, int? MaxOutputTokens,
    string? Mode, string[] SupportedFeatures);

public sealed class LiteLlmVirtualKeyService(IHttpClientFactory clients, IOptions<LiteLlmOptions> configured,
    AigcHubDbContext db, IDataProtectionProvider protection,
    ILogger<LiteLlmVirtualKeyService> logger)
{
    private readonly IDataProtector _protector = protection.CreateProtector("AigcHub.ManagedVirtualKey.v1");
    private readonly SemaphoreSlim _capabilityLock = new(1, 1);
    private static readonly IReadOnlyDictionary<string, LiteLlmModelCapability> NoCapabilities =
        new Dictionary<string, LiteLlmModelCapability>(StringComparer.Ordinal);
    private (DateTimeOffset ExpiresAt, IReadOnlyDictionary<string, LiteLlmModelCapability> Models)? _capabilityCache;

    /// <summary>
    /// Read the per-model capabilities LiteLLM discloses for the configured proxy, cached for five minutes.
    /// A model whose <c>model_info</c> omits a field is reported without that field so the caller falls back
    /// instead of receiving a fabricated capacity.
    /// </summary>
    /// <param name="ct">Cancellation for the management request.</param>
    /// <returns>One entry per LiteLLM <c>model_name</c>; empty when LiteLLM is unconfigured or unreachable.</returns>
    public async Task<IReadOnlyDictionary<string, LiteLlmModelCapability>> CapabilitiesAsync(CancellationToken ct)
    {
        if (_capabilityCache is { } cached && cached.ExpiresAt > DateTimeOffset.UtcNow) return cached.Models;
        await _capabilityLock.WaitAsync(ct);
        try
        {
            if (_capabilityCache is { } fresh && fresh.ExpiresAt > DateTimeOffset.UtcNow) return fresh.Models;
            var options = configured.Value;
            if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var internalBase)
                || string.IsNullOrWhiteSpace(options.ManagementApiKey)) return NoCapabilities;
            var root = internalBase.ToString().TrimEnd('/');
            if (root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3];
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{root}/model/info");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ManagementApiKey.Trim());
            using var response = await clients.CreateClient("litellm-key-management").SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) throw new HttpRequestException($"LiteLLM model info returned {(int)response.StatusCode}");
            using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var models = new Dictionary<string, LiteLlmModelCapability>(StringComparer.Ordinal);
            if (body.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in data.EnumerateArray())
                {
                    if (!item.TryGetProperty("model_name", out var name) || name.ValueKind != JsonValueKind.String) continue;
                    var info = item.TryGetProperty("model_info", out var declared) && declared.ValueKind == JsonValueKind.Object
                        ? declared : default;
                    var vision = info.ValueKind == JsonValueKind.Object
                        && info.TryGetProperty("supports_vision", out var flag) && flag.ValueKind == JsonValueKind.True;
                    models[name.GetString()!] = new LiteLlmModelCapability(vision,
                        PositiveTokenCount(info, "max_input_tokens"),
                        PositiveTokenCount(info, "max_output_tokens") ?? PositiveTokenCount(info, "max_tokens"),
                        info.ValueKind == JsonValueKind.Object && info.TryGetProperty("mode", out var mode)
                            && mode.ValueKind == JsonValueKind.String ? mode.GetString() : null,
                        info.ValueKind == JsonValueKind.Object
                            ? info.EnumerateObject().Where(property => property.Name.StartsWith("supports_", StringComparison.Ordinal)
                                && property.Value.ValueKind == JsonValueKind.True)
                                .Select(property => property.Name).Order(StringComparer.Ordinal).ToArray()
                            : []);
                }
            }
            _capabilityCache = (DateTimeOffset.UtcNow.AddMinutes(5), models);
            return models;
        }
        catch (Exception exception) when (exception is HttpRequestException or JsonException)
        {
            logger.LogWarning(exception, "LiteLLM model capability lookup failed; DSH models report no capabilities");
            return NoCapabilities;
        }
        finally { _capabilityLock.Release(); }
    }

    /// <summary>Read one positive token count from a LiteLLM <c>model_info</c> object; absent or non-positive yields null.</summary>
    /// <param name="info">The <c>model_info</c> object, or the default element when LiteLLM disclosed none.</param>
    /// <param name="field">Token-count field name.</param>
    /// <returns>The count, or null when LiteLLM does not state one.</returns>
    private static int? PositiveTokenCount(JsonElement info, string field) =>
        info.ValueKind == JsonValueKind.Object && info.TryGetProperty(field, out var value)
            && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number > 0 ? number : null;

    public async Task<LiteLlmSessionCredential> GetAsync(Guid userId, CancellationToken ct)
    {
        var options = configured.Value;
        if (!Uri.TryCreate(options.PublicBaseUrl, UriKind.Absolute, out var publicBase))
            throw new WorkflowException("LiteLLM公开接入地址未配置", 503);
        var user = await db.Users.AsNoTracking().SingleAsync(x => x.Id == userId, ct);
        var departmentEnabled = await db.Departments.AsNoTracking()
            .AnyAsync(x => x.Id == user.DepartmentId && x.IsEnabled, ct);
        var organizationIds = await db.VirtualKeyOrganizationMembers.AsNoTracking()
            .Where(x => x.UserId == userId).Select(x => x.OrganizationId).ToArrayAsync(ct);
        var roleIds = await db.Users.AsNoTracking().Where(x => x.Id == userId)
            .SelectMany(x => x.Roles.Select(r => r.RoleId)).ToArrayAsync(ct);
        var grantKeys = await db.AccessGrants.AsNoTracking().Where(grant =>
            (grant.SubjectType == "User" && grant.SubjectId == userId)
            || (departmentEnabled && grant.SubjectType == "Department" && grant.SubjectId == user.DepartmentId)
            || (grant.SubjectType == "Role" && roleIds.Contains(grant.SubjectId))
            || (grant.SubjectType == "Organization" && organizationIds.Contains(grant.SubjectId)))
            .Select(x => x.ResourceKey).ToArrayAsync(ct);
        var keys = await db.ManagedVirtualKeys.AsNoTracking().Where(x => x.IsEnabled).ToArrayAsync(ct);
        keys = keys.Where(x => grantKeys.Contains($"virtual-key:{x.Id:D}", StringComparer.Ordinal)).ToArray();
        if (keys.Length == 0) throw new WorkflowException("登录成功，但尚未绑定 LiteLLM 虚拟 Key，请联系管理员", 403);
        if (keys.Length > 1) throw new WorkflowException("当前用户绑定了多个 LiteLLM 虚拟 Key，请管理员调整授权范围", 409);
        return new LiteLlmSessionCredential(publicBase.ToString().TrimEnd('/'), _protector.Unprotect(keys[0].KeyProtected), null);
    }

    public async Task<string> CreateAsync(string alias, string? customKey, CancellationToken ct)
    {
        var options = configured.Value;
        if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var internalBase)
            || string.IsNullOrWhiteSpace(options.ManagementApiKey))
            throw new WorkflowException("LiteLLM 管理接口未配置", 503);
        var root = internalBase.ToString().TrimEnd('/');
        if (root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3];
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{root}/key/generate");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ManagementApiKey.Trim());
        request.Content = new StringContent(JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["key_alias"] = alias, ["key"] = customKey,
            ["metadata"] = new { source = "aigc-managed" }
        }), Encoding.UTF8, "application/json");
        using var response = await clients.CreateClient("litellm-key-management").SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new WorkflowException($"LiteLLM 虚拟 Key 创建失败（{(int)response.StatusCode}）", 502);
        using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        if (!body.RootElement.TryGetProperty("key", out var value) || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString())) throw new WorkflowException("LiteLLM 响应缺少 Key", 502);
        return _protector.Protect(value.GetString()!);
    }

    public async Task SetBlockedAsync(string protectedKey, bool blocked, CancellationToken ct)
    {
        var options = configured.Value;
        if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var internalBase)
            || string.IsNullOrWhiteSpace(options.ManagementApiKey))
            throw new WorkflowException("LiteLLM 管理接口未配置", 503);
        var root = internalBase.ToString().TrimEnd('/');
        if (root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase)) root = root[..^3];
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{root}/key/{(blocked ? "block" : "unblock")}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.ManagementApiKey.Trim());
        request.Content = new StringContent(JsonSerializer.Serialize(new { key = _protector.Unprotect(protectedKey) }),
            Encoding.UTF8, "application/json");
        using var response = await clients.CreateClient("litellm-key-management").SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new WorkflowException($"LiteLLM 虚拟 Key {(blocked ? "封禁" : "解封")}失败（{(int)response.StatusCode}）", 502);
    }
}
