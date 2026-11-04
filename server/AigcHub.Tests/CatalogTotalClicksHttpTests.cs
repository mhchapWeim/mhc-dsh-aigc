using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Endpoints;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

/// <summary>The portal card shows a lifetime total; the click report keeps its four windows.</summary>
public sealed class CatalogTotalClicksHttpTests
{
    [Fact]
    public async Task Catalog_exposes_a_lifetime_total_that_stays_out_of_the_reporting_windows()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var id = await Create(admin, category.Id, "设备助手");

        var now = DateTimeOffset.UtcNow;
        // Two launches inside today's window, one from a previous year. Minutes rather than
        // days, so the assertion does not depend on which side of midnight the test runs.
        db.ApplicationClicks.AddRange(
            new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-5) },
            new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddMinutes(-10) },
            new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = now.AddYears(-1).AddDays(-10) });
        await db.SaveChangesAsync();

        var card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        // The total spans all history, while the day window only sees today.
        Assert.Equal(3, card.GetProperty("totalClicks").GetInt64());
        Assert.Equal(2, card.GetProperty("clicks").GetProperty("day").GetInt64());

        // Adjusting a period window moves that window only. The lifetime total is set on
        // its own row, so an administrator correcting 日点击 cannot silently move the card.
        db.ApplicationClickAdjustments.Add(new ApplicationClickAdjustment
        { ApplicationId = id, Period = "day", PeriodStart = ApplicationClickService.Periods(now)["day"], Offset = 7 });
        await db.SaveChangesAsync();
        card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(9, card.GetProperty("clicks").GetProperty("day").GetInt64());
        Assert.Equal(3, card.GetProperty("totalClicks").GetInt64());

        // The click report keeps its original four-window shape; no total leaks into it.
        var report = (await admin.GetFromJsonAsync<JsonElement>("/api/application-registry/click-report")).GetProperty("items")
            .EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.False(report.GetProperty("clicks").TryGetProperty("total", out _));
        Assert.True(report.GetProperty("clicks").TryGetProperty("year", out _));
    }

    [Fact]
    public async Task Opening_a_registered_app_returns_its_total_alongside_the_windows()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var id = await Create(admin, category.Id, "质量助手");
        db.ApplicationClicks.Add(new ApplicationClick
        { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow.AddDays(-400) });
        await db.SaveChangesAsync();

        var response = await user.PostAsJsonAsync($"/api/catalog/registered-apps/{id}/access", new { visitId = Guid.NewGuid() });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        // One historical launch plus the one this request just recorded.
        Assert.Equal(2, body.GetProperty("totalClicks").GetInt64());
        Assert.True(body.GetProperty("counted").GetBoolean());
    }

    [Fact]
    public async Task Registry_can_set_the_lifetime_total_without_touching_the_windows()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var id = await Create(admin, category.Id, "设备助手");
        db.ApplicationClicks.AddRange(
            new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-5) },
            new ApplicationClick { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow.AddYears(-1) });
        await db.SaveChangesAsync();

        // The registry list exposes the current lifetime figure so the editor starts from it.
        var listed = (await admin.GetFromJsonAsync<JsonElement>("/api/application-registry")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(2, listed.GetProperty("totalClicks").GetInt64());

        var input = RegistryInput(id, category.Id, total: 5000);
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();

        var card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(5000, card.GetProperty("totalClicks").GetInt64());
        // A lifetime-only edit leaves the period windows exactly as recorded.
        Assert.Equal(1, card.GetProperty("clicks").GetProperty("day").GetInt64());

        // Raising the total again is relative to recorded clicks, not cumulative on the last edit.
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", RegistryInput(id, category.Id, total: 12))).EnsureSuccessStatusCode();
        card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(12, card.GetProperty("totalClicks").GetInt64());

        // A later real launch still adds to the adjusted figure.
        await user.PostAsJsonAsync($"/api/catalog/registered-apps/{id}/access", new { visitId = Guid.NewGuid() });
        card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(13, card.GetProperty("totalClicks").GetInt64());
    }

    [Fact]
    public async Task Raw_json_payload_with_clicks_total_moves_the_lifetime_figure()
    {
        // This is the exact body the registry page sends. A typed request would bind
        // through the C# record and hide a wire-name mismatch, so the JSON is literal.
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var id = await Create(admin, category.Id, "设备助手");
        db.ApplicationClicks.Add(new ApplicationClick
        { ApplicationId = id, UserId = person.Id, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-5) });
        await db.SaveChangesAsync();

        var body = """
            {"name":"设备助手","nameEn":"Device Assistant","description":"简介","descriptionEn":"Description",
             "owner":"质量部","ownerEn":"Quality","categoryId":"CATEGORY_ID","categoryEn":"Smart services",
             "accessUrl":"https://example.com/device","isEnabled":true,"sortOrder":1,"accessMode":"All",
             "grants":[],"clicks":{"total":777}}
            """.Replace("CATEGORY_ID", category.Id.ToString());
        var put = await admin.PutAsync($"/api/application-registry/{id}",
            new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
        put.EnsureSuccessStatusCode();

        var card = (await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal(777, card.GetProperty("totalClicks").GetInt64());
        // The windows were not part of this payload, so they keep their recorded values.
        Assert.Equal(1, card.GetProperty("clicks").GetProperty("day").GetInt64());
    }

    private static ApplicationRegistryEndpoints.SaveInput RegistryInput(Guid id, Guid categoryId, long total) => new(
        "设备助手", "Device Assistant", "简介", "Description", "质量部", "Quality", categoryId, "Smart services",
        "https://example.com/device", true, 1, "All", [], new ApplicationClickUpdate(Total: total));

    private static async Task<Guid> Create(HttpClient admin, Guid categoryId, string name)
    {
        var input = new ApplicationRegistryEndpoints.SaveInput(name, name + " EN", "简介", "Description", "质量部", "Quality",
            categoryId, "Smart services", $"https://example.com/{Guid.NewGuid():N}", true, 1, "All", []);
        var response = await admin.PostAsJsonAsync("/api/application-registry", input);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"create {name}: {(int)response.StatusCode}");
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
        private readonly string database = "totals-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services => {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
