using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Endpoints;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

/// <summary>The portal's "recently used" strip must come from real launches, per account.</summary>
public sealed class RecentCatalogHttpTests
{
    [Fact]
    public async Task Lists_only_this_accounts_launches_newest_first_and_drops_lost_access()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var adminUser = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var category = await db.Categories.FirstAsync();

        var first = await Create(admin, category.Id, "设备助手", "https://example.com/device", "All");
        var second = await Create(admin, category.Id, "质量助手", "https://example.com/quality", "All");
        var restricted = await Create(admin, category.Id, "受限应用", "https://example.com/limited", "Subjects");

        // Nothing opened yet: an empty history, never a placeholder entry.
        Assert.Empty((await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray());

        var now = DateTimeOffset.UtcNow;
        db.ApplicationClicks.AddRange(
            new ApplicationClick { ApplicationId = first, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-30) },
            new ApplicationClick { ApplicationId = second, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-5) },
            // Another account's launch must not appear in this user's strip.
            new ApplicationClick { ApplicationId = restricted, UserId = adminUser.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-1) });
        await db.SaveChangesAsync();

        var recent = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray().ToArray();
        Assert.Equal([second, first], recent.Select(x => x.GetProperty("id").GetGuid()).ToArray());
        Assert.Equal("质量助手", recent[0].GetProperty("name").GetString());
        // Registered applications resolve their URL on entry, so the client needs this flag.
        Assert.True(recent[0].GetProperty("registered").GetBoolean());

        // Recency is the maximum of repeat launches, not the first one.
        db.ApplicationClicks.Add(new ApplicationClick { ApplicationId = first, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now });
        await db.SaveChangesAsync();
        recent = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray().ToArray();
        Assert.Equal([first, second], recent.Select(x => x.GetProperty("id").GetGuid()).ToArray());

        // Losing the grant removes an entry even though the click history remains.
        var limited = new ApplicationRegistryEndpoints.SaveInput("受限应用", "Limited", "简介", "Description", "质量部", "Quality",
            category.Id, "Smart services", "https://example.com/limited", true, 1, "Subjects", [new("User", person.Id)]);
        (await admin.PutAsJsonAsync($"/api/application-registry/{restricted}", limited)).EnsureSuccessStatusCode();
        await user.PostAsJsonAsync($"/api/catalog/registered-apps/{restricted}/access", new { visitId = Guid.NewGuid() });
        recent = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray().ToArray();
        Assert.Contains(recent, x => x.GetProperty("id").GetGuid() == restricted);

        limited = limited with { Grants = [] };
        (await admin.PutAsJsonAsync($"/api/application-registry/{restricted}", limited)).EnsureSuccessStatusCode();
        recent = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray().ToArray();
        Assert.DoesNotContain(recent, x => x.GetProperty("id").GetGuid() == restricted);
    }

    [Fact]
    public async Task Caps_the_strip_and_requires_a_signed_in_account()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var now = DateTimeOffset.UtcNow;
        for (var index = 0; index < 8; index++)
        {
            var id = await Create(admin, category.Id, $"应用{index}", $"https://example.com/{index}", "All");
            db.ApplicationClicks.Add(new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-index) });
        }
        await db.SaveChangesAsync();

        using var user = await Login(factory, "wh00412");
        var recent = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps?limit=3")).EnumerateArray().ToArray();
        Assert.Equal(["应用0", "应用1", "应用2"], recent.Select(x => x.GetProperty("name").GetString()).ToArray());
        Assert.Equal(6, (await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).GetArrayLength());

        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/catalog/recent-apps")).StatusCode);
    }

    private static async Task<Guid> Create(HttpClient admin, Guid categoryId, string name, string accessUrl, string accessMode)
    {
        var input = new ApplicationRegistryEndpoints.SaveInput(name, name + " EN", "简介", "Description", "质量部", "Quality",
            categoryId, "Smart services", accessUrl, true, 1, accessMode, []);
        var response = await admin.PostAsJsonAsync("/api/application-registry", input);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"create {name}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<HttpClient> Login(Factory factory, string employeeNo)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("accessToken").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string database = "recent-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services => {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
