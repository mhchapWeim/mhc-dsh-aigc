using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace AigcHub.Api.Services;

public sealed record VirtualKeyPolicy(string[] Models, bool AllModels = false, decimal? MaxBudget = null,
    string? BudgetDuration = null, long? RpmLimit = null, long? TpmLimit = null,
    string? Duration = null, bool ClearExpiry = false);
public sealed record VirtualKeyPolicyView(string[] Models, bool AllModels, decimal? MaxBudget,
    string? BudgetDuration, long? RpmLimit, long? TpmLimit, DateTimeOffset? Expires);

public sealed partial class LiteLlmVirtualKeyService
{
    public static void ValidatePolicy(VirtualKeyPolicy policy)
    {
        if (policy.Models is null || policy.Models.Length > 1000 || policy.Models.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > 200)
            || policy.Models.Distinct(StringComparer.Ordinal).Count() != policy.Models.Length
            || (policy.AllModels ? policy.Models.Length != 0 : policy.Models.Length == 0))
            throw new WorkflowException("请选择至少一个模型，或明确选择全部模型", 400);
        if (policy.MaxBudget is < 0 || policy.RpmLimit is <= 0 || policy.TpmLimit is <= 0)
            throw new WorkflowException("预算不能为负数，RPM 和 TPM 须为正整数；留空表示不设置 Key 级限制", 400);
        foreach (var duration in new[] { policy.BudgetDuration, policy.Duration })
            if (duration is not null && !Regex.IsMatch(duration, @"^(?:[1-9][0-9]{0,6}(?:mo|[smhdw])|hourly|daily|weekly|monthly)$", RegexOptions.CultureInvariant))
                throw new WorkflowException("周期须为正整数加 s/m/h/d/w/mo，或 hourly/daily/weekly/monthly", 400);
        if (policy.ClearExpiry && policy.Duration is not null)
            throw new WorkflowException("不能同时设置有效期和永久有效", 400);
    }

    private static Dictionary<string, object?> PolicyPayload(VirtualKeyPolicy policy) => new()
    {
        ["models"] = policy.Models, ["max_budget"] = policy.MaxBudget,
        ["budget_duration"] = policy.BudgetDuration, ["rpm_limit"] = policy.RpmLimit, ["tpm_limit"] = policy.TpmLimit
    };

    private string ManagementRoot()
    {
        var options = configured.Value;
        if (!Uri.TryCreate(options.BaseUrl, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https") || string.IsNullOrWhiteSpace(options.ManagementApiKey))
            throw new WorkflowException("LiteLLM 管理接口未配置", 503);
        var root = uri.ToString().TrimEnd('/');
        return root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) ? root[..^3] : root;
    }

    private async Task<JsonDocument> PolicyRequestAsync(HttpMethod method, string path, object? payload, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, $"{ManagementRoot()}{path}");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configured.Value.ManagementApiKey.Trim());
        if (payload is not null) request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        try
        {
            using var response = await clients.CreateClient("litellm-key-management").SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
                throw new WorkflowException($"LiteLLM 配置请求失败（HTTP {(int)response.StatusCode}），配置未确认同步，请检查网关权限和参数", 502);
            return await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            throw new WorkflowException("LiteLLM 配置请求失败或响应无效，请重新读取配置确认同步结果", 502);
        }
    }

    public async Task<string[]> PolicyModelOptionsAsync(CancellationToken ct)
    {
        using var response = await PolicyRequestAsync(HttpMethod.Get, "/v1/models", null, ct);
        if (!response.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array || data.GetArrayLength() > 10000)
            throw new WorkflowException("LiteLLM 模型目录无效", 502);
        var models = new List<string>();
        foreach (var item in data.EnumerateArray())
        {
            if (!item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(id.GetString()))
                throw new WorkflowException("LiteLLM 模型目录包含无效标识", 502);
            models.Add(id.GetString()!);
        }
        return models.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    }

    public async Task<VirtualKeyPolicyView> GetPolicyAsync(string protectedKey, CancellationToken ct)
    {
        // The proxy accepts hashes. Do not place plaintext keys in URLs or access logs.
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_protector.Unprotect(protectedKey)))).ToLowerInvariant();
        using var response = await PolicyRequestAsync(HttpMethod.Get, $"/key/info?key={hash}", null, ct);
        if (!response.RootElement.TryGetProperty("info", out var info) || info.ValueKind != JsonValueKind.Object
            || !info.TryGetProperty("models", out var models) || models.ValueKind != JsonValueKind.Array
            || models.EnumerateArray().Any(x => x.ValueKind != JsonValueKind.String))
            throw new WorkflowException("LiteLLM Key 配置响应无效", 502);
        var identifiers = models.EnumerateArray().Select(x => x.GetString()!).ToArray();
        return new(identifiers, identifiers.Length == 0, ReadDecimal(info, "max_budget"), ReadString(info, "budget_duration"),
            ReadLong(info, "rpm_limit"), ReadLong(info, "tpm_limit"),
            ReadExpiry(info));
    }

    public async Task UpdatePolicyAsync(string protectedKey, VirtualKeyPolicy policy, CancellationToken ct)
    {
        ValidatePolicy(policy);
        var current = await GetPolicyAsync(protectedKey, ct);
        var available = await PolicyModelOptionsAsync(ct);
        if (policy.Models.Except(current.Models, StringComparer.Ordinal).Except(available, StringComparer.Ordinal).Any())
            throw new WorkflowException("所选模型已不在 LiteLLM 目录中，请刷新模型列表", 400);
        var payload = new Dictionary<string, object?> { ["key"] = _protector.Unprotect(protectedKey) };
        if (!policy.Models.Order(StringComparer.Ordinal).SequenceEqual(current.Models.Order(StringComparer.Ordinal))) payload["models"] = policy.Models;
        if (policy.MaxBudget != current.MaxBudget) payload["max_budget"] = policy.MaxBudget;
        if (policy.BudgetDuration != current.BudgetDuration) payload["budget_duration"] = policy.BudgetDuration;
        if (policy.RpmLimit != current.RpmLimit) payload["rpm_limit"] = policy.RpmLimit;
        if (policy.TpmLimit != current.TpmLimit) payload["tpm_limit"] = policy.TpmLimit;
        if (policy.Duration is not null) payload["duration"] = policy.Duration;
        else if (policy.ClearExpiry) payload["duration"] = "-1";
        // Omit unchanged reset/expiry fields: editing RPM must not renew the key or reset its budget window.
        if (payload.Count == 1) return;
        using var response = await PolicyRequestAsync(HttpMethod.Post, "/key/update", payload, ct);
    }

    private static string? ReadString(JsonElement value, string key) => value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
    private static decimal? ReadDecimal(JsonElement value, string key)
    {
        if (!value.TryGetProperty(key, out var field) || field.ValueKind == JsonValueKind.Null) return null;
        if (field.ValueKind == JsonValueKind.Number && field.TryGetDecimal(out var result)) return result;
        throw new WorkflowException("LiteLLM Key 预算响应无效，未将其视为无限额", 502);
    }
    private static long? ReadLong(JsonElement value, string key)
    {
        if (!value.TryGetProperty(key, out var field) || field.ValueKind == JsonValueKind.Null) return null;
        if (field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out var result)) return result;
        throw new WorkflowException("LiteLLM Key 速率限制响应无效，未将其视为无限额", 502);
    }
    private static DateTimeOffset? ReadExpiry(JsonElement value)
    {
        if (!value.TryGetProperty("expires", out var field) || field.ValueKind == JsonValueKind.Null) return null;
        if (field.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(field.GetString(), out var result)) return result;
        throw new WorkflowException("LiteLLM Key 到期时间响应无效，未将其视为永久有效", 502);
    }
}
