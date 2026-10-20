using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class PortalSsoHttpTests
{
    [Fact]
    public async Task SsoIssuesThePortalJwtWithExistingRolesAndNoTokenInRedirect()
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        var start = await client.GetAsync("/api/auth/sso/start?returnTo=%2Fadmin%2Fmodels");
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        Assert.Contains(start.Headers.GetValues("Set-Cookie"), value => value.Contains("HttpOnly", StringComparison.OrdinalIgnoreCase));
        var service = QueryHelpers.ParseQuery(start.Headers.Location!.Query)["service"].ToString();
        Assert.StartsWith("https://localhost/v1/auth/cas/callback?portal_state=", service);
        var callback = await client.GetAsync(QueryHelpers.AddQueryString(service, "ticket", "valid-ticket"));
        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        Assert.Contains("sso=complete", callback.Headers.Location!.ToString());
        Assert.DoesNotContain("token", callback.Headers.Location.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(service, fixture.Factory.Cas.LastService);
        Assert.Equal("no-store", callback.Headers.CacheControl!.ToString());
        client.DefaultRequestHeaders.Add("Origin", "https://localhost");
        var complete = await client.PostAsync("/api/auth/sso/complete", null);
        Assert.Equal(HttpStatusCode.OK, complete.StatusCode);
        var session = await complete.Content.ReadFromJsonAsync<JsonElement>();
        var access = session.GetProperty("accessToken").GetString();
        Assert.Contains("admin.view", session.GetProperty("user").GetProperty("permissions").EnumerateArray().Select(item => item.GetString()));
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", access);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/auth/sso/complete", null)).StatusCode);
    }

    [Fact]
    public async Task FreshSsoUserReceivesOnlyOrdinaryRoleAndNoSharedPassword()
    {
        using var fixture = new Fixture("newemployee");
        using var client = fixture.Client();
        var callback = await CompleteCallback(client);
        Assert.Contains("sso=complete", callback.Headers.Location!.ToString());
        client.DefaultRequestHeaders.Add("Origin", "https://localhost");
        var response = await client.PostAsync("/api/auth/sso/complete", null);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        var permissions = session.GetProperty("user").GetProperty("permissions").EnumerateArray().Select(item => item.GetString()).ToArray();
        Assert.Contains("portal.view", permissions);
        Assert.DoesNotContain("user.manage", permissions);
        Assert.DoesNotContain("role.manage", permissions);
        Assert.DoesNotContain("model.manage", permissions);
        Assert.Contains("普通用户", session.GetProperty("user").GetProperty("roles").EnumerateArray().Select(item => item.GetString()));
        using var scope = fixture.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var user = await db.Users.SingleAsync(user => user.EmployeeNo == "newemployee");
        Assert.Null(user.DepartmentId);
        var hasher = scope.ServiceProvider.GetRequiredService<IPasswordHasher<AigcHub.Api.Domain.AppUser>>();
        Assert.Equal(PasswordVerificationResult.Failed, hasher.VerifyHashedPassword(user, user.PasswordHash, "Bhss@123"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CallbackRejectsMissingOrMismatchedBrowserState(bool mismatch)
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        if (mismatch) await client.GetAsync("/api/auth/sso/start");
        var response = await client.GetAsync("/v1/auth/cas/callback?portal_state=wrong-state&ticket=valid-ticket");
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Contains("sso=expired", response.Headers.Location!.ToString());
        Assert.Null(fixture.Factory.Cas.LastService);
    }

    [Fact]
    public async Task CompletionRejectsUntrustedOriginsWithoutLosingTheValidResult()
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        await CompleteCallback(client);
        client.DefaultRequestHeaders.Add("Origin", "https://untrusted.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync("/api/auth/sso/complete", null)).StatusCode);
        client.DefaultRequestHeaders.Remove("Origin");
        client.DefaultRequestHeaders.Add("Origin", "https://localhost");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/auth/sso/complete", null)).StatusCode);
    }

    [Fact]
    public async Task InvalidCasTicketDoesNotCreatePortalCredentials()
    {
        using var fixture = new Fixture { };
        fixture.Factory.Cas.Reply = "<serviceResponse><authenticationFailure code=\"INVALID_TICKET\" /></serviceResponse>";
        using var client = fixture.Client();
        var response = await CompleteCallback(client);
        Assert.Contains("sso=failed", response.Headers.Location!.ToString());
        client.DefaultRequestHeaders.Add("Origin", "https://localhost");
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/auth/sso/complete", null)).StatusCode);
    }

    [Fact]
    public async Task DisabledUserCannotCompleteSso()
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        using (var scope = fixture.Factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            (await db.Users.SingleAsync(user => user.EmployeeNo == "wh00028")).IsEnabled = false;
            await db.SaveChangesAsync();
        }
        Assert.Contains("sso=disabled", (await CompleteCallback(client)).Headers.Location!.ToString());
    }

    [Fact]
    public async Task ExpiredCorrelationCannotValidateACasTicket()
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        using var scope = fixture.Factory.Services.CreateScope();
        var protector = scope.ServiceProvider.GetRequiredService<IDataProtectionProvider>()
            .CreateProtector("AigcHub.PortalSso.Pending.v1").ToTimeLimitedDataProtector();
        var state = new string('a', 64);
        var cookie = protector.Protect(JsonSerializer.Serialize(new PortalSsoFlow.Pending(state, "/")), DateTimeOffset.UtcNow.AddMinutes(-1));
        client.DefaultRequestHeaders.Add("Cookie", $"{PortalSsoFlow.PendingCookie}={cookie}");
        var response = await client.GetAsync($"/v1/auth/cas/callback?portal_state={state}&ticket=valid-ticket");
        Assert.Contains("sso=expired", response.Headers.Location!.ToString());
        Assert.Null(fixture.Factory.Cas.LastService);
    }

    [Fact]
    public async Task ForgedCompletionCookieCannotIssueAJwt()
    {
        using var fixture = new Fixture();
        using var client = fixture.Client();
        client.DefaultRequestHeaders.Add("Origin", "https://localhost");
        client.DefaultRequestHeaders.Add("Cookie", $"{PortalSsoFlow.CompletionCookie}=forged");
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/api/auth/sso/complete", null)).StatusCode);
    }

    [Fact]
    public async Task CasXmlCannotResolveExternalEntities()
    {
        using var fixture = new Fixture();
        fixture.Factory.Cas.Reply = "<!DOCTYPE serviceResponse [<!ENTITY xxe SYSTEM 'file:///not-readable'>]><serviceResponse><authenticationSuccess><user>&xxe;</user></authenticationSuccess></serviceResponse>";
        using var client = fixture.Client();
        Assert.Contains("sso=failed", (await CompleteCallback(client)).Headers.Location!.ToString());
    }

    [Theory]
    [InlineData("https://evil.example")]
    [InlineData("//evil.example")]
    [InlineData("/\\evil.example")]
    [InlineData("/%2f%2fevil.example")]
    [InlineData("/\t/evil.example")]
    [InlineData("/login")]
    [InlineData("/login/local")]
    public void ReturnDestinationCannotEscapeThePortal(string input) => Assert.Equal("/", PortalSsoFlow.SafeReturnTo(input));

    private static async Task<HttpResponseMessage> CompleteCallback(HttpClient client)
    {
        var start = await client.GetAsync("/api/auth/sso/start");
        var service = QueryHelpers.ParseQuery(start.Headers.Location!.Query)["service"].ToString();
        return await client.GetAsync(QueryHelpers.AddQueryString(service, "ticket", "valid-ticket"));
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), $"aigc-portal-sso-{Guid.NewGuid():N}");
        public Factory Factory { get; }
        public Fixture(string employeeNo = "wh00028")
        {
            Directory.CreateDirectory(_root);
            Factory = new Factory(_root, employeeNo);
        }
        public HttpClient Client() => Factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false
        });
        public void Dispose() { Factory.Dispose(); Directory.Delete(_root, true); }
    }

    private sealed class Factory(string root, string employeeNo) : WebApplicationFactory<Program>
    {
        private readonly string _database = $"portal-sso-{Guid.NewGuid():N}";
        public CasHandler Cas { get; } = new(employeeNo);
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("Cas:Enabled", "true");
            builder.UseSetting("Cas:ServiceUrl", "https://localhost/v1/auth/cas/callback");
            builder.UseSetting("Cas:PortalBaseUrl", "https://localhost");
            builder.UseSetting("DshUploads:Root", root);
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(_database));
                services.AddHttpClient("bhss-cas").ConfigurePrimaryHttpMessageHandler(() => Cas);
            });
        }
    }
    private sealed class CasHandler(string employeeNo) : HttpMessageHandler
    {
        public string? LastService { get; private set; }
        public string Reply { get; set; } = $"<serviceResponse><authenticationSuccess><user>{employeeNo}</user><name>Test user</name></authenticationSuccess></serviceResponse>";
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastService = QueryHelpers.ParseQuery(request.RequestUri!.Query)["service"].ToString();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Reply) });
        }
    }
}
