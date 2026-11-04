using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Endpoints;
using AigcHub.Api.Services;
using AigcHub.Api.Contracts;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class ApplicationRegistryHttpTests
{
    [Fact]
    public async Task Visible_to_everyone_but_access_requires_current_grants_and_enabled_state()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var input = new ApplicationRegistryEndpoints.SaveInput("设备助手", "Device Assistant", "设备知识", "Equipment knowledge",
            "质量部", "Quality", category.Id, "Smart services", "https://example.com/device", true, 1, "Subjects", []);
        var create = await admin.PostAsJsonAsync("/api/application-registry", input);
        create.EnsureSuccessStatusCode();
        var id = (await create.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var path = $"/api/catalog/registered-apps/{id}/access";
        var catalog = await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps");
        var card = catalog.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal("Device Assistant", card.GetProperty("nameEn").GetString());
        Assert.Equal("", card.GetProperty("accessUrl").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync(path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.GetAsync(path)).StatusCode);

        input = input with { Grants = [new("Department", person.DepartmentId!.Value)] };
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        Assert.Equal("https://example.com/device", (await user.GetFromJsonAsync<JsonElement>(path)).GetProperty("accessUrl").GetString());
        input = input with { Grants = [new("User", person.Id)] };
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        (await user.GetAsync(path)).EnsureSuccessStatusCode();
        input = input with { Grants = [] };
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync(path)).StatusCode);
        input = input with { AccessMode = "All" };
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        (await user.GetAsync(path)).EnsureSuccessStatusCode();
        input = input with { IsEnabled = false };
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await user.GetAsync(path)).StatusCode);
        catalog = await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps");
        Assert.DoesNotContain(catalog.EnumerateArray(), x => x.GetProperty("id").GetGuid() == id);
    }

    [Fact]
    public async Task Non_admin_cannot_manage_registry_and_invalid_inputs_are_rejected()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028"); using var user = await Login(factory, "wh00412");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/api/application-registry")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/application-registry/translate", new { text = "测试" })).StatusCode);
        using var scope = factory.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var category = await db.Categories.FirstAsync();
        var input = new ApplicationRegistryEndpoints.SaveInput("测试", "Test", "说明", "Description", "", "", category.Id, "", "javascript:alert(1)", true, 0, "Subjects", []);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/application-registry", input)).StatusCode);
        input = input with { AccessUrl = "https://example.com", Grants = [new("User", Guid.NewGuid())] };
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/application-registry", input)).StatusCode);
        input = input with { Grants = [], NameEn = "" };
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/application-registry", input)).StatusCode);
    }

    [Fact]
    public async Task Clicks_require_authorization_debounce_persist_and_adjust_without_rewriting_raw_history()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var user = await Login(factory, "wh00412");
        Guid categoryId, userId;
        using (var scope = factory.Services.CreateScope()) {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            categoryId = (await db.Categories.FirstAsync()).Id;
            userId = (await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412")).Id;
        }
        var input = new ApplicationRegistryEndpoints.SaveInput("点击验证", "Clicks", "说明", "", "", "", categoryId, "", "https://example.com/click", true, 0, "Subjects", []);
        var created = await admin.PostAsJsonAsync("/api/application-registry", input); created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var access = $"/api/catalog/registered-apps/{id}/access";
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync(access, new {visitId = Guid.NewGuid()})).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/api/application-registry/click-report")).StatusCode);
        input = input with {AccessMode = "All"};
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input)).EnsureSuccessStatusCode();
        // Legacy GET probes are read-only, including repeated authorization checks.
        (await user.GetAsync(access)).EnsureSuccessStatusCode();
        var visitId = Guid.NewGuid();
        (await user.PostAsJsonAsync(access, new {visitId})).EnsureSuccessStatusCode();
        (await user.PostAsJsonAsync(access, new {visitId})).EnsureSuccessStatusCode();
        (await user.PostAsJsonAsync(access, new {visitId = Guid.NewGuid()})).EnsureSuccessStatusCode();
        (await admin.PostAsJsonAsync(access, new {visitId})).EnsureSuccessStatusCode();
        async Task<JsonElement> Counts() => (await admin.GetFromJsonAsync<JsonElement>("/api/application-registry/click-report"))
            .GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id).GetProperty("clicks");
        var counts = await Counts();
        foreach (var period in new[] {"day", "week", "month", "year"}) Assert.Equal(2, counts.GetProperty(period).GetInt64());
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input with {Clicks = new(10, 20, 30, 40)})).EnsureSuccessStatusCode();
        Assert.Equal(10, (await Counts()).GetProperty("day").GetInt64());
        // Partial adjustments must not reset other periods or clicks received while a form was open.
        (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input with {Clicks = new(Day: 15)})).EnsureSuccessStatusCode();
        counts = await Counts();
        Assert.Equal(15, counts.GetProperty("day").GetInt64()); Assert.Equal(20, counts.GetProperty("week").GetInt64());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/application-registry/{id}", input with {Clicks = new(Day: -1)})).StatusCode);
        using (var scope = factory.Services.CreateScope()) {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            Assert.Equal(2, await db.ApplicationClicks.CountAsync(x => x.ApplicationId == id));
            Assert.Equal(2, await db.OperationAudits.CountAsync(x => x.Action == "application.clicks.adjust" && x.EntityId == id.ToString()));
            // Move only the debounce timestamp outside the window, then exercise a new valid launch.
            var click = await db.ApplicationClicks.SingleAsync(x => x.ApplicationId == id && x.UserId == userId);
            click.CreatedAt = click.CreatedAt.AddSeconds(-4); await db.SaveChangesAsync();
        }
        (await user.PostAsJsonAsync(access, new {visitId})).EnsureSuccessStatusCode(); // persistent idempotency beyond debounce
        (await user.PostAsJsonAsync(access, new {visitId = Guid.NewGuid()})).EnsureSuccessStatusCode();
        counts = await Counts(); Assert.Equal(16, counts.GetProperty("day").GetInt64()); Assert.Equal(21, counts.GetProperty("week").GetInt64());
        var catalog = await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps");
        Assert.Equal(41, catalog.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id).GetProperty("clicks").GetProperty("year").GetInt64());
        var today = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).Date;
        var query = $"/api/application-registry/click-report?applicationId={id}&from={today:yyyy-MM-dd}&to={today.AddDays(1):yyyy-MM-dd}";
        var history = await admin.GetFromJsonAsync<JsonElement>(query);
        Assert.Single(history.GetProperty("items").EnumerateArray());
        Assert.Equal(3, history.GetProperty("items")[0].GetProperty("rangeClicks").GetInt64());
        Assert.Equal(3, history.GetProperty("trend")[0].GetProperty("clicks").GetInt64());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/application-registry/click-report?from=2026-11-04&to=2026-11-04")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/application-registry/click-report?from=2024-01-01&to=2026-01-01")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/application-registry/click-report?from=invalid")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"/api/application-registry/click-report?applicationId={Guid.NewGuid()}")).StatusCode);

    }

    [Fact]
    public async Task Categories_allow_two_levels_bind_catalog_and_reject_cycles_and_deleting_bound_nodes()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028"); using var user = await Login(factory, "wh00412");
        var rootInput = new SaveCategoryRequest("root-test", "测试一级", "", "#2465d0", 1, true);
        var rootResponse = await admin.PostAsJsonAsync("/api/categories", rootInput); rootResponse.EnsureSuccessStatusCode();
        var root = (await rootResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var childInput = rootInput with {Code = "child-test", Name = "测试二级", ParentId = root};
        var childResponse = await admin.PostAsJsonAsync("/api/categories", childInput); childResponse.EnsureSuccessStatusCode();
        var child = (await childResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/categories", childInput with {Code = "grandchild", Name = "三级", ParentId = child})).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/categories/{root}", rootInput with {ParentId = child})).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync($"/api/categories/{child}", childInput with {ParentId = child})).StatusCode);
        (await admin.PutAsJsonAsync($"/api/categories/{child}", childInput with {Name = "更新二级"})).EnsureSuccessStatusCode();
        var appInput = new ApplicationRegistryEndpoints.SaveInput("二级应用", "Child app", "说明", "", "", "", child, "", "https://example.com", true, 0, "All", []);
        var appResponse = await admin.PostAsJsonAsync("/api/application-registry", appInput); appResponse.EnsureSuccessStatusCode();
        var id = (await appResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var catalog = await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps");
        var card = catalog.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == id);
        Assert.Equal("测试一级", card.GetProperty("category").GetString()); Assert.Equal("更新二级", card.GetProperty("subcategory").GetString());
        var otherRootResponse = await admin.PostAsJsonAsync("/api/categories", rootInput with {Code = "other-root", Name = "另一一级"});
        otherRootResponse.EnsureSuccessStatusCode();
        var otherRoot = (await otherRootResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync("/api/categories", childInput with {Code = "other-child", Name = "更新二级", ParentId = otherRoot})).EnsureSuccessStatusCode();
        Assert.Equal(child, card.GetProperty("subcategoryId").GetGuid());
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync($"/api/categories/{root}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync($"/api/categories/{child}")).StatusCode);
    }

    [Fact]
    public async Task Concurrent_category_moves_cannot_create_a_cycle()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028");
        var firstInput = new SaveCategoryRequest("move-a", "Move A", "", "#2465d0", 0, true);
        var secondInput = firstInput with {Code = "move-b", Name = "Move B"};
        var first = await admin.PostAsJsonAsync("/api/categories", firstInput); first.EnsureSuccessStatusCode();
        var second = await admin.PostAsJsonAsync("/api/categories", secondInput); second.EnsureSuccessStatusCode();
        var a = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var b = (await second.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var moved = await Task.WhenAll(admin.PutAsJsonAsync($"/api/categories/{a}", firstInput with {ParentId = b}),
            admin.PutAsJsonAsync($"/api/categories/{b}", secondInput with {ParentId = a}));
        Assert.Single(moved.Where(x => x.IsSuccessStatusCode));
        Assert.Single(moved.Where(x => x.StatusCode == HttpStatusCode.BadRequest));
    }

    [Fact]
    public async Task Calendar_boundaries_use_beijing_midnight_and_adjustments_expire_with_their_period()
    {
        using var factory = new Factory(); using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>(); var id = Guid.NewGuid();
        var now = DateTimeOffset.Parse("2027-01-03T16:00:01Z"); // Monday Jan 4, 00:00:01 Beijing
        var periods = ApplicationClickService.Periods(now);
        Assert.Equal(DateTimeOffset.Parse("2027-01-03T16:00:00Z"), periods["day"]);
        Assert.Equal(periods["day"], periods["week"]);
        Assert.Equal(DateTimeOffset.Parse("2026-12-31T16:00:00Z"), periods["year"]);
        db.ApplicationClicks.AddRange(new ApplicationClick {ApplicationId = id, VisitId = Guid.NewGuid(), CreatedAt = now.AddSeconds(-2)},
            new ApplicationClick {ApplicationId = id, VisitId = Guid.NewGuid(), CreatedAt = now});
        db.ApplicationClickAdjustments.Add(new() {ApplicationId = id, Period = "day", PeriodStart = periods["day"].AddDays(-1), Offset = 100});
        await db.SaveChangesAsync();
        var counts = (await ApplicationClickService.CountsAsync(db, [id], now, default))[id];
        Assert.Equal(new ApplicationClickCounts(1, 1, 2, 2), counts);
        var history = await ApplicationClickService.HistoryAsync(db, [id], "2027-01-03", "2027-01-06", now, default);
        Assert.Equal(new long[] {1, 1, 0}, history.Trend.Select(x => x.Clicks).ToArray());
        Assert.Equal(2, history.ByApplication[id]);

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
        private readonly string database = "registry-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services => {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
