using System.Net;
using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text.Json;
using AigcHub.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class InstallerDiagnosticsHttpTests
{
    [Fact]
    public async Task AnonymousInstallerFailureIsBoundedDeduplicatedAndDoesNotImpersonateAUser()
    {
        using var factory = new Factory();
        using var client = factory.CreateClient();
        var report = new { eventId = Guid.NewGuid(), deviceId = Guid.NewGuid(), occurredAt = DateTimeOffset.UtcNow,
            appVersion = "0.1.7-alpha.2.20261013.1", stage = "preflight", code = 5,
            error = "Access denied; token=secret-test", installPath = @"D:\Program Files (x86)\wanzai", elevated = false,
            windowsVersion = "10.0.26100", computerName = "TEST-PC" };
        (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", report)).EnsureSuccessStatusCode();
        (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", report)).EnsureSuccessStatusCode();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var row = await db.DshFailures.SingleAsync();
        Assert.Null(row.UserId);
        Assert.Equal("installer", row.Category);
        Assert.Contains("Code: 5", row.PayloadJson);
        Assert.DoesNotContain("secret-test", row.PayloadJson);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", report with { stage = "tool" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", report with { error = new string('x', 24_001) })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/dsh-failures/")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = Array.Empty<object>() })).StatusCode);
        var login = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
        login.EnsureSuccessStatusCode();
        var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var listing = await client.GetFromJsonAsync<JsonElement>("/api/dsh-failures/?category=installer");
        Assert.Equal("安装器（未登录）", listing.GetProperty("items")[0].GetProperty("displayName").GetString());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/dsh-failures/{row.Id}/download")).StatusCode);
    }

    [Fact]
    public async Task AnonymousIngestionIsRateLimited()
    {
        using var factory = new Factory(); using var client = factory.CreateClient();
        for (var i = 0; i < 30; i++)
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsJsonAsync("/v1/desktop/installer-diagnostics", new { })).StatusCode);
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string database = Guid.NewGuid().ToString();
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(Path.GetTempPath(), "aigc-installer-test-keys"));
            builder.ConfigureServices(services => {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
            });
        }
    }
}
