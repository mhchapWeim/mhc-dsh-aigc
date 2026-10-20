using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

public sealed record AvailableChatModel(Guid Id, string Name, string ProviderKind, string ModelIdentifier,
    bool SupportsTools, bool IsDefault, string ImageInputMode = "Auto", string Multiplier = "");

public sealed record ResolvedChatModel(Guid Id, string Name, string ProviderKind, string BaseUrl,
    string EndpointPath, string ModelIdentifier, string ApiKey, string AuthType, string ApiKeyHeader,
    bool SupportsTools, double Temperature, int? MaxTokens, int TimeoutSeconds, string ImageInputMode = "Auto", string Multiplier = "");

public sealed class ModelConfigurationService(
    AigcHubDbContext db,
    AccessGrantService grants,
    IDataProtectionProvider protectionProvider,
    IOptions<ChatOptions> legacyOptions)
{
    public ModelConfigurationService(AigcHubDbContext db, IDataProtectionProvider protectionProvider,
        IOptions<ChatOptions> legacyOptions) : this(db, new AccessGrantService(db), protectionProvider, legacyOptions) { }
    private readonly IDataProtector _protector = protectionProvider.CreateProtector("AigcHub.ModelApiKeys.v1");
    private readonly ChatOptions _legacy = legacyOptions.Value;

    public async Task<IReadOnlyList<AvailableChatModel>> AvailableAsync(Guid userId, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking().Where(x => x.Id == userId && x.IsEnabled)
            .Select(x => new { x.DepartmentId }).SingleOrDefaultAsync(ct);
        if (user is null) return [];
        var directIds = await db.UserModelGrants.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.ModelId).ToArrayAsync(ct);
        var roleIds = await db.UserRoles.AsNoTracking().Where(x => x.UserId == userId).Select(x => x.RoleId).ToArrayAsync(ct);
        var departmentEnabled = await db.Departments.AsNoTracking().AnyAsync(x => x.Id == user.DepartmentId && x.IsEnabled, ct);
        var keys = await db.AccessGrants.AsNoTracking().Where(x => x.ResourceKey.StartsWith("model:")
            && ((x.SubjectType == "User" && x.SubjectId == userId)
                || (x.SubjectType == "Role" && roleIds.Contains(x.SubjectId))
                || (x.SubjectType == "Department" && departmentEnabled && x.SubjectId == user.DepartmentId)))
            .Select(x => x.ResourceKey).ToArrayAsync(ct);
        var allowed = directIds.ToHashSet();
        foreach (var key in keys)
            if (Guid.TryParse(key["model:".Length..], out var id)) allowed.Add(id);
        var items = await db.ModelConfigurations.AsNoTracking().Where(x => x.IsEnabled && allowed.Contains(x.Id))
            .OrderByDescending(x => x.IsDefault).ThenBy(x => x.SortOrder).ThenBy(x => x.Name)
            .Select(x => new AvailableChatModel(x.Id, x.Name, x.ProviderKind, x.ModelIdentifier, x.SupportsTools, x.IsDefault, x.ImageInputMode, x.Multiplier))
            .ToListAsync(ct);
        return items;
    }

    public async Task<ResolvedChatModel?> ResolveGrantedAsync(Guid userId, Guid? modelId, CancellationToken ct)
    {
        if (modelId == Guid.Empty) throw new WorkflowException("该模型未向当前用户授权", 403);
        var selected = modelId ?? (await AvailableAsync(userId, ct)).FirstOrDefault()?.Id;
        if (selected is null) return null;
        var allowed = await db.Users.AnyAsync(x => x.Id == userId && x.IsEnabled, ct)
            && (await db.UserModelGrants.AnyAsync(x => x.UserId == userId && x.ModelId == selected, ct)
                || await grants.AllowsAsync(AccessGrantService.ModelKey(selected.Value), userId, ct));
        if (!allowed) throw new WorkflowException("该模型未向当前用户授权", 403);
        return await ResolveAsync(selected, ct);
    }

    public async Task<Guid[]> GrantedUserIdsAsync(Guid modelId, CancellationToken ct) =>
        await db.UserModelGrants.AsNoTracking().Where(x => x.ModelId == modelId)
            .Select(x => x.UserId).ToArrayAsync(ct);

    public async Task SetGrantedUsersAsync(Guid modelId, Guid[] userIds, CancellationToken ct)
    {
        if (!await db.ModelConfigurations.AnyAsync(x => x.Id == modelId, ct))
            throw new WorkflowException("模型配置不存在", 404);
        var selected = userIds.Distinct().ToArray();
        if (await db.Users.CountAsync(x => selected.Contains(x.Id) && x.IsEnabled, ct) != selected.Length)
            throw new WorkflowException("包含不存在或已停用的用户", 400);
        var existing = await db.UserModelGrants.Where(x => x.ModelId == modelId).ToListAsync(ct);
        db.UserModelGrants.RemoveRange(existing.Where(x => !selected.Contains(x.UserId)));
        db.UserModelGrants.AddRange(selected.Except(existing.Select(x => x.UserId))
            .Select(userId => new UserModelGrant { UserId = userId, ModelId = modelId }));
        await db.SaveChangesAsync(ct);
    }

    public async Task<object[]> AdminListAsync(LiteLlmVirtualKeyService virtualKeys, CancellationToken ct)
    {
        var models = await db.ModelConfigurations.AsNoTracking()
            .OrderByDescending(x => x.IsDefault).ThenBy(x => x.SortOrder).ThenBy(x => x.Name).ToListAsync(ct);
        var capabilities = models.Any(x => x.ProviderKind == "LiteLLM")
            ? await virtualKeys.CapabilitiesAsync(ct)
            : new Dictionary<string, LiteLlmModelCapability>(StringComparer.Ordinal);
        return models.Select(model => View(model,
            model.ProviderKind == "LiteLLM" && capabilities.TryGetValue(model.ModelIdentifier, out var capability)
                ? capability : null)).ToArray();
    }

    public async Task<AiModelConfiguration> SaveAsync(Guid? id, SaveModelConfigurationRequest input, CancellationToken ct)
    {
        Validate(input);
        if (await db.ModelConfigurations.AnyAsync(x => x.Name == input.Name.Trim() && x.Id != id, ct))
            throw new WorkflowException("模型显示名称已存在", 409);
        var entity = id.HasValue
            ? await db.ModelConfigurations.SingleOrDefaultAsync(x => x.Id == id, ct) ?? throw new WorkflowException("模型配置不存在", 404)
            : new AiModelConfiguration { Name = "", BaseUrl = "", ModelIdentifier = "" };
        if (input.Multiplier is not null) entity.Multiplier = input.Multiplier.Trim();
        entity.Name = input.Name.Trim();
        entity.ProviderKind = input.ProviderKind;
        entity.BaseUrl = input.BaseUrl.TrimEnd('/');
        entity.EndpointPath = "/" + input.EndpointPath.Trim().TrimStart('/');
        entity.ModelIdentifier = input.ModelIdentifier.Trim();
        entity.AuthType = input.AuthType;
        entity.ApiKeyHeader = string.IsNullOrWhiteSpace(input.ApiKeyHeader) ? "X-API-Key" : input.ApiKeyHeader.Trim();
        if (input.Multiplier?.Length > 32) throw new WorkflowException("倍率文本不能超过 32 个字符");
        if (input.ImageInputMode is not null) entity.ImageInputMode = input.ImageInputMode;
        entity.SupportsTools = input.SupportsTools;
        entity.IsEnabled = input.IsEnabled;
        entity.IsDefault = input.IsDefault;
        entity.Temperature = input.Temperature;
        entity.MaxTokens = input.MaxTokens;
        entity.SortOrder = input.SortOrder;
        entity.UpdatedAt = DateTimeOffset.UtcNow;
        if (!string.IsNullOrWhiteSpace(input.ApiKey)) entity.ApiKeyProtected = _protector.Protect(input.ApiKey.Trim());
        if (entity.AuthType != "None" && string.IsNullOrWhiteSpace(entity.ApiKeyProtected))
            throw new WorkflowException("当前认证方式必须配置 API Key");
        if (!id.HasValue) db.ModelConfigurations.Add(entity);
        if (entity.IsDefault)
        {
            var previous = await db.ModelConfigurations.Where(x => x.Id != entity.Id && x.IsDefault).ToListAsync(ct);
            foreach (var item in previous) item.IsDefault = false;
        }
        await db.SaveChangesAsync(ct);
        return entity;
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct)
    {
        var entity = await db.ModelConfigurations.SingleOrDefaultAsync(x => x.Id == id, ct)
            ?? throw new WorkflowException("模型配置不存在", 404);
        db.AccessGrants.RemoveRange(await db.AccessGrants.Where(x => x.ResourceKey == AccessGrantService.ModelKey(id)).ToArrayAsync(ct));
        db.ModelConfigurations.Remove(entity);
        await db.SaveChangesAsync(ct);
    }

    public async Task<ResolvedChatModel?> ResolveAsync(Guid? id, CancellationToken ct)
    {
        if (id == Guid.Empty) return LegacyConfigured() ? Legacy() : throw new WorkflowException("环境变量模型未配置", 404);
        AiModelConfiguration? entity;
        if (id.HasValue)
            entity = await db.ModelConfigurations.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.IsEnabled, ct)
                ?? throw new WorkflowException("所选模型不存在或已停用", 404);
        else
            entity = await db.ModelConfigurations.AsNoTracking().Where(x => x.IsEnabled)
                .OrderByDescending(x => x.IsDefault).ThenBy(x => x.SortOrder).ThenBy(x => x.Name).FirstOrDefaultAsync(ct);
        if (entity is null) return LegacyConfigured() ? Legacy() : null;
        string key;
        try
        {
            key = string.IsNullOrWhiteSpace(entity.ApiKeyProtected) ? "" : _protector.Unprotect(entity.ApiKeyProtected);
        }
        catch (CryptographicException)
        {
            throw new WorkflowException("模型 API Key 无法解密，请管理员重新输入密钥或重新同步 LiteLLM 模型", 503);
        }
        return new ResolvedChatModel(entity.Id, entity.Name, entity.ProviderKind, entity.BaseUrl, entity.EndpointPath,
            entity.ModelIdentifier, key, entity.AuthType, entity.ApiKeyHeader, entity.SupportsTools,
            entity.Temperature, entity.MaxTokens, _legacy.TimeoutSeconds, entity.ImageInputMode, entity.Multiplier);
    }

    public static object View(AiModelConfiguration value, LiteLlmModelCapability? capability = null) => new
    {
        value.Id, value.Name, value.ProviderKind, value.Protocol, value.BaseUrl, value.EndpointPath,
        value.ModelIdentifier, HasApiKey = !string.IsNullOrWhiteSpace(value.ApiKeyProtected), value.AuthType,
        value.ApiKeyHeader, value.Multiplier, value.SupportsTools, value.ImageInputMode,
        ImageInput = ModelImageCapability.Resolve(value.ImageInputMode, capability), value.IsEnabled, value.IsDefault, value.Temperature,
        value.MaxTokens, value.SortOrder, value.CreatedAt, value.UpdatedAt,
        LiteLlmCapabilities = capability is null ? null : new
        {
            capability.Mode, capability.SupportedFeatures, capability.ContextWindow, capability.MaxOutputTokens
        }
    };

    private static void Validate(SaveModelConfigurationRequest input)
    {
        if (string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.ModelIdentifier))
            throw new WorkflowException("模型名称和模型标识不能为空");
        if (input.Multiplier?.Length > 32) throw new WorkflowException("倍率文本不能超过 32 个字符");
        if (input.ImageInputMode is not null && !new[] { "Auto", "Supported", "Unsupported" }.Contains(input.ImageInputMode))
            throw new WorkflowException("图片理解配置无效");
        if (!new[] { "Local", "Online", "LiteLLM" }.Contains(input.ProviderKind)) throw new WorkflowException("接入类型无效");
        if (!new[] { "None", "Bearer", "Header" }.Contains(input.AuthType)) throw new WorkflowException("认证方式无效");
        if (!Uri.TryCreate(input.BaseUrl, UriKind.Absolute, out var uri)) throw new WorkflowException("服务地址无效");
        if (input.ProviderKind == "Online" && uri.Scheme != Uri.UriSchemeHttps) throw new WorkflowException("在线模型必须使用 HTTPS 地址");
        if (input.ProviderKind is "Local" or "LiteLLM" && uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) throw new WorkflowException("本地模型或 LiteLLM 地址必须使用 HTTP 或 HTTPS");
        if (string.IsNullOrWhiteSpace(input.EndpointPath)) throw new WorkflowException("接口路径不能为空");
        if (input.Temperature is < 0 or > 2) throw new WorkflowException("Temperature 必须在 0 到 2 之间");
        if (input.MaxTokens is <= 0) throw new WorkflowException("最大输出 Token 必须大于 0");
    }

    private bool LegacyConfigured() => Uri.TryCreate(_legacy.BaseUrl, UriKind.Absolute, out _) && !string.IsNullOrWhiteSpace(_legacy.Model);
    private ResolvedChatModel Legacy() => new(Guid.Empty, $"环境变量 · {_legacy.Model}", "Environment", _legacy.BaseUrl,
        "/chat/completions", _legacy.Model, _legacy.ApiKey, "Bearer", "X-API-Key", true, 0.3, null, _legacy.TimeoutSeconds);
}
