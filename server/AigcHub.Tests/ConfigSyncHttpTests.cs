using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class ConfigSyncHttpTests
{
    [Fact]
    public async Task Config_changes_create_outbox_but_login_and_receipts_do_not()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028", false);
        using var scope = factory.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var before = await db.ConfigSyncEvents.CountAsync();
        var revision = (await db.ConfigSyncRevisions.SingleAsync()).Revision;
        var plan = new TokenBillingPlan { Name = "热更新配方", WeeklyTokens = 1000 }; db.TokenBillingPlans.Add(plan);
        await db.SaveChangesAsync();
        Assert.Equal(before + 1, await db.ConfigSyncEvents.CountAsync());
        Assert.Equal(revision + 1, (await db.ConfigSyncRevisions.SingleAsync()).Revision);
        Assert.Equal("Pending", (await db.ConfigSyncEvents.OrderByDescending(x => x.Revision).FirstAsync()).Status);
        await db.SaveChangesAsync();
        using var dsh = await Login(factory, "wh00412", true);
        Assert.Equal(before + 1, await db.ConfigSyncEvents.CountAsync());
        (await dsh.PostAsJsonAsync("/v1/config/applied", new ConfigSyncReport(Guid.NewGuid(), "test-device", "test", 0, Guid.Empty, "Heartbeat"))).EnsureSuccessStatusCode();
        Assert.Equal(before + 1, await db.ConfigSyncEvents.CountAsync());
        plan.WeeklyTokens = 2000; await db.SaveChangesAsync();
        Assert.Equal(revision + 2, (await db.ConfigSyncRevisions.SingleAsync()).Revision);
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        db.TokenBillingAssignments.Add(new TokenBillingAssignment { SubjectType = "User", SubjectId = person.Id, PlanId = plan.Id });
        await db.SaveChangesAsync();
        Assert.Equal(revision + 3, (await db.ConfigSyncRevisions.SingleAsync()).Revision);
        person.DepartmentId = null; await db.SaveChangesAsync();
        Assert.Equal(revision + 4, (await db.ConfigSyncRevisions.SingleAsync()).Revision);
    }

    [Fact]
    public async Task Applied_receipt_requires_issued_snapshot_and_admin_tracks_pending_failed_applied_offline()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028", false); using var dsh = await Login(factory, "wh00412", true);
        var deviceId = Guid.NewGuid();
        var snapshot = await dsh.GetFromJsonAsync<JsonElement>($"/v1/config/snapshot?deviceId={deviceId}");
        var revision = snapshot.GetProperty("revision").GetInt64();
        var offerId = snapshot.GetProperty("offerId").GetGuid();
        var report = new ConfigSyncReport(deviceId, "设备甲", "0.1.7-test", revision, Guid.NewGuid(), "Applied");
        Assert.Equal(HttpStatusCode.Conflict, (await dsh.PostAsJsonAsync("/v1/config/applied", report)).StatusCode);
        report = report with { OfferId = offerId, Status = "Failed", ErrorCode = "APPLY_FAILED" };
        (await dsh.PostAsJsonAsync("/v1/config/applied", report)).EnsureSuccessStatusCode();
        Assert.Equal("Failed", (await Device(admin, deviceId)).GetProperty("status").GetString());
        report = report with { Status = "Applied", ErrorCode = "" };
        (await dsh.PostAsJsonAsync("/v1/config/applied", report)).EnsureSuccessStatusCode();
        (await dsh.PostAsJsonAsync("/v1/config/applied", report)).EnsureSuccessStatusCode();
        Assert.Equal("Applied", (await Device(admin, deviceId)).GetProperty("status").GetString());
        Assert.Equal(revision, (await Device(admin, deviceId)).GetProperty("appliedRevision").GetInt64());
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            db.TokenBillingPlans.Add(new TokenBillingPlan { Name = "另一配方", WeeklyTokens = 200 }); await db.SaveChangesAsync();
        }
        Assert.Equal("Pending", (await Device(admin, deviceId)).GetProperty("status").GetString());
        // A heartbeat cannot falsely mark the current target as applied.
        (await dsh.PostAsJsonAsync("/v1/config/applied", report with { Revision = revision + 1, Status = "Heartbeat" })).EnsureSuccessStatusCode();
        Assert.Equal("Pending", (await Device(admin, deviceId)).GetProperty("status").GetString());
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            (await db.ConfigSyncDevices.SingleAsync()).LastSeenAt = DateTimeOffset.UtcNow.AddMinutes(-5); await db.SaveChangesAsync();
        }
        Assert.Equal("Offline", (await Device(admin, deviceId)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Receipts_are_bound_to_login_identity_and_future_versions_are_rejected()
    {
        using var factory = new Factory(); using var dsh = await Login(factory, "wh00412", true); using var other = await Login(factory, "wh00028", true);
        using var plain = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await plain.GetAsync("/v1/config/versions")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await plain.GetAsync("/v1/config/events")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await dsh.GetAsync("/api/config-sync/devices?page=1&pageSize=5")).StatusCode);
        var device = Guid.NewGuid(); var snapshot = await dsh.GetFromJsonAsync<JsonElement>($"/v1/config/snapshot?deviceId={device}");
        var report = new ConfigSyncReport(device, "device", "test", snapshot.GetProperty("revision").GetInt64(), snapshot.GetProperty("offerId").GetGuid(), "Applied");
        Assert.Equal(HttpStatusCode.Conflict, (await other.PostAsJsonAsync("/v1/config/applied", report)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await dsh.PostAsJsonAsync("/v1/config/applied", report with { Revision = long.MaxValue })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await dsh.PostAsJsonAsync("/v1/config/applied", report with { Status = "Unknown" })).StatusCode);
        using var userPortal = await Login(factory, "wh00412", false);
        Assert.Equal(HttpStatusCode.Forbidden, (await userPortal.GetAsync("/api/config-sync/devices?page=1&pageSize=5")).StatusCode);
    }

    [Fact]
    public async Task Custom_model_permission_defaults_closed_and_updates_snapshots_without_changing_legacy_user_edits()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028", false);
        using var desktop = await Login(factory, "wh00412", true); using var portal = await Login(factory, "wh00412", false);
        var person = (await admin.GetFromJsonAsync<JsonElement>("/api/users?page=1&pageSize=100&keyword=wh00412")).GetProperty("items")[0];
        var id = person.GetProperty("id").GetGuid();
        Assert.False(person.GetProperty("allowCustomModels").GetBoolean());
        var body = new AigcHub.Api.Contracts.SaveUserRequest(person.GetProperty("employeeNo").GetString()!, person.GetProperty("name").GetString()!, person.GetProperty("email").GetString()!, null,
            person.GetProperty("departmentId").ValueKind == JsonValueKind.Null ? null : person.GetProperty("departmentId").GetGuid(),
            person.GetProperty("roles").EnumerateArray().Select(x => x.GetProperty("roleId").GetGuid()).ToArray(), true);
        var before = await desktop.GetFromJsonAsync<JsonElement>("/v1/config/versions");
        (await admin.PutAsJsonAsync($"/api/users/{id}", body with {AllowCustomModels = true})).EnsureSuccessStatusCode();
        Assert.True((await desktop.GetFromJsonAsync<JsonElement>("/v1/auth/me")).GetProperty("capabilities").GetProperty("allowCustomModels").GetBoolean());
        var deviceId = Guid.NewGuid();
        var snapshot = await desktop.GetFromJsonAsync<JsonElement>($"/v1/config/snapshot?deviceId={deviceId}");
        Assert.True(snapshot.GetProperty("capabilities").GetProperty("allowCustomModels").GetBoolean());
        Assert.True(snapshot.GetProperty("revision").GetInt64() > before.GetProperty("revision").GetInt64());
        (await admin.PutAsJsonAsync($"/api/users/{id}", body)).EnsureSuccessStatusCode(); // Old clients omit the new field.
        Assert.True((await desktop.GetFromJsonAsync<JsonElement>("/v1/auth/me")).GetProperty("capabilities").GetProperty("allowCustomModels").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await portal.PutAsJsonAsync($"/api/users/{id}", body with {AllowCustomModels = false})).StatusCode);
        (await admin.PutAsJsonAsync($"/api/users/{id}", body with {AllowCustomModels = false})).EnsureSuccessStatusCode();
        snapshot = await desktop.GetFromJsonAsync<JsonElement>($"/v1/config/snapshot?deviceId={deviceId}");
        Assert.False(snapshot.GetProperty("capabilities").GetProperty("allowCustomModels").GetBoolean());
        using var scope = factory.Services.CreateScope(); var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.Equal(2, await db.OperationAudits.CountAsync(x => x.Action == "user.custom-models.permission" && x.EntityId == id.ToString()));
    }

    private static async Task<JsonElement> Device(HttpClient admin, Guid id)
    {
        var result = await admin.GetFromJsonAsync<JsonElement>("/api/config-sync/devices?page=1&pageSize=100");
        return result.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("deviceId").ValueKind == JsonValueKind.String && x.GetProperty("deviceId").GetGuid() == id).Clone();
    }
    private static async Task<HttpClient> Login(Factory factory, string user, bool desktop)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync(desktop ? "/v1/auth/login" : "/api/auth/login", desktop
            ? (object)new { username = user, password = "Bhss@123" } : new { employeeNo = user, password = "Bhss@123" });
        response.EnsureSuccessStatusCode(); var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty(desktop ? "access_token" : "accessToken").GetString());
        return client;
    }
    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string database = "config-sync-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services => {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
