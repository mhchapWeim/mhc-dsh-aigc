using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record GiteaSelection(string ServiceCode, long RepositoryId, string Ref, string? CommitSha = null);
public sealed record GiteaSnapshot(string RepositoryUrl, string Branch, string CommitSha, string FullName = "");

public sealed class GiteaService(AigcHubDbContext db, IConfiguration config, IHttpClientFactory clients, IDataProtectionProvider protection)
{
    private sealed record Tokens(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt);
    private readonly IDataProtector protector = protection.CreateProtector("Gitea.UserAuthorization.v1");

    private async Task<(IntegrationService Service, IConfigurationSection Settings, Uri Base)> SettingsAsync(string code, CancellationToken ct)
    {
        var service = await db.IntegrationServices.SingleOrDefaultAsync(x => x.Code == code && x.Kind == "Gitea" && x.IsEnabled, ct)
            ?? throw new WorkflowException("Gitea 服务未启用", 409);
        var settings = config.GetSection($"IntegrationConnections:{service.ConnectionKey}");
        if (!Uri.TryCreate(settings["BaseUrl"]?.TrimEnd('/') + "/", UriKind.Absolute, out var root) || !Secure(root, settings) || !string.IsNullOrEmpty(root.UserInfo) || root.Query.Length > 0 || root.Fragment.Length > 0)
            throw new WorkflowException("请配置 Gitea HTTPS 地址", 409);
        return (service, settings, root);
    }

    // Production requires HTTPS. Local debugging may opt into plain HTTP, but only
    // for a loopback address and only when the connection explicitly enables it.
    private static bool Secure(Uri uri, IConfigurationSection settings) =>
        uri.Scheme == "https" || (uri.Scheme == "http" && uri.IsLoopback && settings.GetValue("AllowInsecureHttp", false));

    public async Task<string> AuthorizeAsync(Guid userId, string code, CancellationToken ct)
    {
        var (_, settings, root) = await SettingsAsync(code, ct);
        var clientId = settings["ClientId"];
        if (string.IsNullOrWhiteSpace(clientId) || !Uri.TryCreate(settings["RedirectUri"], UriKind.Absolute, out var redirect) || !Secure(redirect, settings))
            throw new WorkflowException("管理员需先登记 Gitea OAuth 应用并配置 ClientId 和回调地址", 409);
        var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var authorization = new GiteaAuthorization { UserId = userId, ServiceCode = code,
            VerifierProtected = protector.Protect(verifier), ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10) };
        db.GiteaAuthorizations.Add(authorization);
        await db.SaveChangesAsync(ct);
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return new Uri(root, "login/oauth/authorize") + "?response_type=code&client_id=" + Uri.EscapeDataString(clientId) +
            "&redirect_uri=" + Uri.EscapeDataString(redirect.ToString()) + "&scope=" + Uri.EscapeDataString("read:user read:repository") +
            "&state=" + authorization.Id + "&code_challenge_method=S256&code_challenge=" + challenge;
    }

    public async Task CompleteAsync(Guid userId, Guid state, string code, CancellationToken ct)
    {
        await using var transaction = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        if (db.Database.IsNpgsql())
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({state.ToString()}))", ct);
        var auth = await db.GiteaAuthorizations.SingleOrDefaultAsync(x => x.Id == state && x.UserId == userId, ct)
            ?? throw new WorkflowException("授权状态无效，请重新连接", 409);
        if (auth.Consumed) throw new WorkflowException("该授权已完成，请勿重复提交", 409);
        if (auth.ExpiresAt <= DateTimeOffset.UtcNow) throw new WorkflowException("授权已过期，请重新连接", 409);
        var (_, settings, root) = await SettingsAsync(auth.ServiceCode, ct);
        // Claim the state before exchanging the one-time code so concurrent callbacks cannot
        // bind two accounts. The claim is released again if the exchange fails, otherwise a
        // single bad attempt would permanently burn the user's authorization attempt.
        auth.Consumed = true;
        try
        {
            using var response = await clients.CreateClient(ClientName(settings)).PostAsync(new Uri(root, "login/oauth/access_token"),
                new FormUrlEncodedContent(new Dictionary<string, string> {
                    ["grant_type"] = "authorization_code", ["code"] = code, ["client_id"] = settings["ClientId"] ?? "",
                    ["client_secret"] = settings["ClientSecret"] ?? "", ["redirect_uri"] = settings["RedirectUri"] ?? "",
                    ["code_verifier"] = protector.Unprotect(auth.VerifierProtected)
                }), ct);
            if (!response.IsSuccessStatusCode) throw new WorkflowException("Gitea 授权交换失败，请重新连接", 502);
            using var tokens = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var token = tokens.RootElement.GetProperty("access_token").GetString()!;
            var identity = await RequestAsync(root, token, "user", settings, ct);
            var externalId = identity.GetProperty("id").GetInt64();
            if (await db.GiteaConnections.AnyAsync(x => x.ServiceCode == auth.ServiceCode && x.ExternalUserId == externalId && x.UserId != userId, ct))
                throw new WorkflowException("该 Gitea 账号已关联其他用户", 409);
            var connection = await db.GiteaConnections.SingleOrDefaultAsync(x => x.UserId == userId && x.ServiceCode == auth.ServiceCode, ct);
            if (connection is null) { connection = new GiteaConnection { UserId = userId, ServiceCode = auth.ServiceCode }; db.Add(connection); }
            connection.ExternalUserId = externalId;
            connection.Login = identity.GetProperty("login").GetString()!;
            connection.TokenProtected = ProtectTokens(tokens.RootElement);
            await db.SaveChangesAsync(ct);
            if (transaction is not null) await transaction.CommitAsync(ct);
        }
        catch
        {
            // Release the claim so the applicant can retry with a fresh authorization instead
            // of being told the state was already used.
            auth.Consumed = false;
            // No catch-path SaveChanges: a failed account bind must not accidentally save
            // tracked credentials. The transaction rolls back the state and binding together.
            db.ChangeTracker.Clear();
            throw;
        }
    }

    public async Task<JsonElement> GetAsync(Guid userId, string serviceCode, string path, CancellationToken ct)
    {
        var (_, settings, root) = await SettingsAsync(serviceCode, ct);
        var connection = await db.GiteaConnections.SingleOrDefaultAsync(x => x.UserId == userId && x.ServiceCode == serviceCode, ct)
            ?? throw new WorkflowException("请先连接您的 Gitea 账号", 409);
        await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        if (db.Database.IsNpgsql())
        {
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({connection.Id.ToString()}))", ct);
            await db.Entry(connection).ReloadAsync(ct);
        }
        var tokens = JsonSerializer.Deserialize<Tokens>(protector.Unprotect(connection.TokenProtected))!;
        if (tokens.ExpiresAt <= DateTimeOffset.UtcNow.AddMinutes(1))
        {
            if (string.IsNullOrEmpty(tokens.RefreshToken)) throw new WorkflowException("Gitea 授权已过期，请重新连接", 409);
            using var response = await clients.CreateClient(ClientName(settings)).PostAsync(new Uri(root, "login/oauth/access_token"), new FormUrlEncodedContent(new Dictionary<string, string> {
                ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken,
                ["client_id"] = settings["ClientId"] ?? "", ["client_secret"] = settings["ClientSecret"] ?? ""
            }), ct);
            if (!response.IsSuccessStatusCode) throw new WorkflowException("Gitea 授权已失效，请重新连接", 409);
            using var refreshed = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            connection.TokenProtected = ProtectTokens(refreshed.RootElement);
            tokens = JsonSerializer.Deserialize<Tokens>(protector.Unprotect(connection.TokenProtected))!;
            await db.SaveChangesAsync(ct);
        }
        if (tx is not null) await tx.CommitAsync(ct);
        return await RequestAsync(root, tokens.AccessToken, path, settings, ct);
    }

    private string ProtectTokens(JsonElement json) => protector.Protect(JsonSerializer.Serialize(new Tokens(
        json.GetProperty("access_token").GetString()!, json.TryGetProperty("refresh_token", out var refresh) ? refresh.GetString() ?? "" : "",
        DateTimeOffset.UtcNow.AddSeconds(json.TryGetProperty("expires_in", out var expiry) ? expiry.GetInt32() : 3600))));

    public static string ClientName(IConfiguration settings) => settings.GetValue("VerifySsl", true) ? "gitea" : "gitea-insecure";

    private async Task<JsonElement> RequestAsync(Uri root, string token, string path, IConfiguration settings, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(root, "api/v1/" + path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await clients.CreateClient(ClientName(settings)).SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            // A repository with no commits is a normal state, not a service failure:
            // Gitea answers 409 "Git Repository is empty." for commit queries.
            if (response.StatusCode is System.Net.HttpStatusCode.Conflict && path.Contains("/commits", StringComparison.Ordinal))
                return EmptyArray;
            throw new WorkflowException(response.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden
                ? "Gitea 授权失效或无权访问，请检查授权" : "Gitea 查询失败", 502);
        }
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return document.RootElement.Clone();
    }

    private static readonly JsonElement EmptyArray = JsonDocument.Parse("[]").RootElement.Clone();

    public async Task<JsonElement> RepositoryDataAsync(Guid userId, string serviceCode, long id, string kind, string? reference, int page, CancellationToken ct)
    {
        var repo = await GetAsync(userId, serviceCode, $"repositories/{id}", ct);
        var fullName = repo.GetProperty("full_name").GetString()!;
        var path = "repos/" + string.Join('/', fullName.Split('/').Select(Uri.EscapeDataString));
        var result = kind switch {
            "branches" or "tags" => await GetAsync(userId, serviceCode, $"{path}/{kind}?page={Math.Max(1, page)}&limit=50", ct),
            "commits" => await GetAsync(userId, serviceCode, $"{path}/commits?sha={Uri.EscapeDataString(reference ?? "")}&page={Math.Max(1, page)}&limit=50", ct),
            _ => throw new WorkflowException("仓库查询类型无效")
        };
        // Gitea reports no branches as JSON null; normalise so callers always see a list.
        return result.ValueKind == JsonValueKind.Null ? EmptyArray : result;
    }

    public async Task<GiteaSnapshot> ResolveAsync(Guid userId, GiteaSelection selection, CancellationToken ct)
    {
        var repo = await GetAsync(userId, selection.ServiceCode, $"repositories/{selection.RepositoryId}", ct);
        if (string.IsNullOrWhiteSpace(selection.Ref)) throw new WorkflowException("请选择代码版本");
        var commits = await RepositoryDataAsync(userId, selection.ServiceCode, selection.RepositoryId, "commits", selection.CommitSha ?? selection.Ref, 1, ct);
        if (commits.GetArrayLength() == 0) throw new WorkflowException("仓库没有可申请的提交");
        return new GiteaSnapshot(repo.GetProperty("html_url").GetString()!, selection.Ref, commits[0].GetProperty("sha").GetString()!, repo.GetProperty("full_name").GetString()!);
    }
}
