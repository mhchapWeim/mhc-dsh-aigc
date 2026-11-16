using System.Net;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.WebUtilities;

namespace AigcHub.Tests;

public sealed class GiteaServiceTests
{
    [Theory]
    [InlineData(null, "gitea")]
    [InlineData("true", "gitea")]
    [InlineData("false", "gitea-insecure")]
    public void Certificate_validation_is_enabled_by_default_and_selected_per_connection(string? value, string expected)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["IntegrationConnections:GiteaBosch:VerifySsl"] = value,
            ["IntegrationConnections:Other:VerifySsl"] = "false"
        }).Build();
        Assert.Equal(expected, GiteaService.ClientName(config.GetSection("IntegrationConnections:GiteaBosch")));
    }

    [Fact]
    public async Task OAuth_is_bound_to_current_user_single_use_and_repository_queries_use_user_token()
    {
        await using var db = CreateDb();
        db.IntegrationServices.Add(new IntegrationService { Code = "gitea", Kind = "Gitea", Name = "代码平台", IsEnabled = true, ConnectionKey = "Git" }); await db.SaveChangesAsync();
        var handler = new FakeGitea(); var client = Service(db, handler); var user = Guid.NewGuid();
        var url = await client.AuthorizeAsync(user, "gitea", default);
        var query = QueryHelpers.ParseQuery(new Uri(url).Query); var state = Guid.Parse(query["state"].ToString());
        Assert.Equal("S256", query["code_challenge_method"]);
        Assert.DoesNotContain("secret", url);
        await Assert.ThrowsAsync<WorkflowException>(() => client.CompleteAsync(Guid.NewGuid(), state, "code", default));
        await client.CompleteAsync(user, state, "code", default);
        await Assert.ThrowsAsync<WorkflowException>(() => client.CompleteAsync(user, state, "code", default));
        var connection = await db.GiteaConnections.SingleAsync();
        Assert.Equal(42, connection.ExternalUserId); Assert.Equal("bosch-user", connection.Login);
        Assert.DoesNotContain("user-access-token", connection.TokenProtected);
        var snapshot = await client.ResolveAsync(user, new GiteaSelection("gitea", 5, "release/1", new string('a', 40)), default);
        Assert.Equal("https://git.example.com/org/app", snapshot.RepositoryUrl);
        Assert.Equal("release/1", snapshot.Branch);
        Assert.Equal(new string('a', 40), snapshot.CommitSha);
        Assert.Contains(handler.Requests, r => r.Contains("sha=" + new string('a', 40)));
        await Assert.ThrowsAsync<WorkflowException>(() => client.GetAsync(Guid.NewGuid(), "gitea", "user/repos", default));
    }

    [Fact]
    public async Task Expired_authorization_cannot_exchange_code()
    {
        await using var db = CreateDb(); var handler = new FakeGitea(); var client = Service(db, handler);
        var user = Guid.NewGuid();
        var state = new GiteaAuthorization { UserId = user, ServiceCode = "gitea", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1) };
        db.Add(state); await db.SaveChangesAsync();
        await Assert.ThrowsAsync<WorkflowException>(() => client.CompleteAsync(user, state.Id, "code", default));
        Assert.Empty(handler.Requests);
    }

    private static GiteaService Service(AigcHubDbContext db, HttpMessageHandler handler) => new(db,
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["IntegrationConnections:Git:BaseUrl"] = "https://git.example.com",
            ["IntegrationConnections:Git:ClientId"] = "client", ["IntegrationConnections:Git:ClientSecret"] = "secret",
            ["IntegrationConnections:Git:RedirectUri"] = "https://portal.example.com/admin/publications/gitea-callback"
        }).Build(), new Factory(handler), new EphemeralDataProtectionProvider());
    private static AigcHubDbContext CreateDb() => new(new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
    [Fact]
    public async Task Empty_repository_reports_no_branches_instead_of_a_service_failure()
    {
        await using var db = CreateDb();
        db.IntegrationServices.Add(new IntegrationService { Code = "gitea", Kind = "Gitea", Name = "代码平台", IsEnabled = true, ConnectionKey = "Git" });
        await db.SaveChangesAsync();
        var handler = new EmptyRepositoryGitea(); var client = Service(db, handler); var user = Guid.NewGuid();
        // Drive the real authorize -> complete flow so the verifier is encrypted by this protector.
        var url = await client.AuthorizeAsync(user, "gitea", default);
        var state = Guid.Parse(QueryHelpers.ParseQuery(new Uri(url).Query)["state"].ToString());
        await client.CompleteAsync(user, state, "code", default);
        // Gitea answers 409 for commits and JSON null for branches of an empty repository.
        var branches = await client.RepositoryDataAsync(user, "gitea", 5, "branches", null, 1, default);
        Assert.Equal(0, branches.GetArrayLength());
        var commits = await client.RepositoryDataAsync(user, "gitea", 5, "commits", "main", 1, default);
        Assert.Equal(0, commits.GetArrayLength());
    }

    private sealed class EmptyRepositoryGitea : HttpMessageHandler
    {
        public string StoredToken { get; private set; } = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/login/oauth/access_token")
            {
                var form = await request.Content!.ReadAsStringAsync(ct);
                Assert.Contains("code_verifier=", form);
                return Json("""{"access_token":"user-access-token","refresh_token":"refresh","expires_in":3600}""");
            }
            if (path == "/api/v1/user") { StoredToken = "user-access-token"; return Json("""{"id":42,"login":"bosch-user"}"""); }
            if (path == "/api/v1/repositories/5") return Json("""{"id":5,"full_name":"org/empty","html_url":"https://git.example.com/org/empty"}""");
            if (path.EndsWith("/branches")) return Json("null");
            if (path.EndsWith("/tags")) return Json("[]");
            if (path.EndsWith("/commits"))
                return new HttpResponseMessage(HttpStatusCode.Conflict) { Content = new StringContent("""{"message":"Git Repository is empty."}""", Encoding.UTF8, "application/json") };
            throw new InvalidOperationException("Unexpected endpoint " + path);        }
        private static HttpResponseMessage Json(string json) =>
            new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    /// <summary>
    /// A failed token exchange must release the one-time state. Otherwise a single transient
    /// error makes every later retry report "authorization already used", which reads as the
    /// user having done something wrong.
    /// </summary>
    [Fact]
    public async Task Failed_exchange_releases_the_state_so_the_user_can_retry()
    {
        await using var db = CreateDb();
        db.IntegrationServices.Add(new IntegrationService { Code = "gitea", Kind = "Gitea", Name = "代码平台", IsEnabled = true, ConnectionKey = "Git" });
        await db.SaveChangesAsync();
        var handler = new FlakyExchangeGitea(); var client = Service(db, handler); var user = Guid.NewGuid();
        var url = await client.AuthorizeAsync(user, "gitea", default);
        var state = Guid.Parse(QueryHelpers.ParseQuery(new Uri(url).Query)["state"].ToString());

        handler.FailExchange = true;
        await Assert.ThrowsAsync<WorkflowException>(() => client.CompleteAsync(user, state, "code", default));
        Assert.False((await db.GiteaAuthorizations.SingleAsync(x => x.Id == state)).Consumed);

        // The same authorization can now be completed once the exchange succeeds.
        handler.FailExchange = false;
        await client.CompleteAsync(user, state, "code", default);
        Assert.True((await db.GiteaAuthorizations.SingleAsync(x => x.Id == state)).Consumed);
        Assert.Equal("bosch-user", (await db.GiteaConnections.SingleAsync()).Login);
    }

    private sealed class FlakyExchangeGitea : HttpMessageHandler
    {
        public bool FailExchange { get; set; }
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/login/oauth/access_token")
            {
                if (FailExchange)
                    return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("""{"error":"invalid_grant"}""") };
                var form = await request.Content!.ReadAsStringAsync(ct);
                Assert.Contains("code_verifier=", form);
                return Json("""{"access_token":"user-access-token","refresh_token":"refresh","expires_in":3600}""");
            }
            if (path == "/api/v1/user") return Json("""{"id":42,"login":"bosch-user"}""");
            throw new InvalidOperationException("Unexpected endpoint " + path);
        }
        private static HttpResponseMessage Json(string json) =>
            new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory { public HttpClient CreateClient(string name) => new(handler, false); }
    private sealed class FakeGitea : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.RequestUri!.PathAndQuery);
            string json;
            if (request.RequestUri.AbsolutePath == "/login/oauth/access_token")
            {
                var form = await request.Content!.ReadAsStringAsync(ct); Assert.Contains("code_verifier=", form);
                json = """{"access_token":"user-access-token","refresh_token":"refresh","expires_in":3600}""";
            }
            else
            {
                Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
                Assert.Equal("user-access-token", request.Headers.Authorization?.Parameter);
                json = request.RequestUri.AbsolutePath switch {
                    "/api/v1/user" => """{"id":42,"login":"bosch-user"}""",
                    "/api/v1/repositories/5" => """{"id":5,"full_name":"org/app","html_url":"https://git.example.com/org/app"}""",
                    "/api/v1/repos/org/app/commits" => JsonSerializer.Serialize(new[] { new { sha = new string('a', 40) } }),
                    _ => throw new InvalidOperationException("Unexpected endpoint")
                };
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
