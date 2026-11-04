using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed partial class LiteLlmVirtualKeyService
{
    /// <summary>Null means no assigned Key; an empty list must never fall back to legacy model grants.</summary>
    public async Task<string[]?> AllowedModelNamesAsync(Guid userId, CancellationToken ct)
    {
        var memberships = await VirtualKeyGrantRules.MembershipsAsync(db, ct);
        if (!memberships.TryGetValue(userId, out var assigned) || assigned.Length == 0) return null;
        if (assigned.Length != 1) throw new WorkflowException("当前用户绑定了多个 LiteLLM 虚拟 Key，请管理员调整授权范围", 409);
        var key = await db.ManagedVirtualKeys.AsNoTracking().SingleAsync(x => x.Id == assigned[0].KeyId, ct);
        if (!key.IsEnabled) return [];
        // Ask the proxy with the user's actual credential rather than interpreting an empty
        // management policy as all models. No management credential is exposed or returned.
        var credential = await GetAsync(userId, ct);
        var root = configured.Value.BaseUrl.TrimEnd('/');
        if (!Uri.TryCreate(root, UriKind.Absolute, out _)) throw new WorkflowException("LiteLLM 接入地址未配置", 503);
        var endpoint = root.EndsWith("/v1", StringComparison.OrdinalIgnoreCase) ? root + "/models" : root + "/v1/models";
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.ApiKey);
        using var response = await clients.CreateClient("litellm-key-management").SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new WorkflowException("无法读取虚拟 Key 的可用模型，请检查 Key 状态与模型授权", 502);
        using var body = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        if (!body.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            throw new WorkflowException("虚拟 Key 模型列表响应无效", 502);
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in data.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String
                || string.IsNullOrWhiteSpace(id.GetString())) throw new WorkflowException("虚拟 Key 模型列表响应无效", 502);
            names.Add(id.GetString()!);
        }
        return names.ToArray();
    }
}