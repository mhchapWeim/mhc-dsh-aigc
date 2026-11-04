using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

/// <summary>Weekly plan assignment, external-model admission and report behaviour over HTTP.</summary>
public sealed class TokenBillingHttpTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData("User")]
    [InlineData("Department")]
    public async Task AssignedPlansCannotBeDeletedEvenWhenDisabledAndUnboundPlansAreSoftDeleted(string type)
    {
        using var factory = new Factory(); using var admin = await Login(factory, false);
        var (userId, departmentId) = await SubjectAsync(factory);
        var subjectId = type == "User" ? userId : departmentId;
        var created = await admin.PostAsJsonAsync("/api/billing/plans", new { name = "待删除配方", weeklyTokens = 1000, isEnabled = false }); created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PutAsJsonAsync($"/api/billing/assignments/{type}/{subjectId}", new { planId = id })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Conflict, (await admin.DeleteAsync($"/api/billing/plans/{id}")).StatusCode);
        (await admin.PutAsJsonAsync($"/api/billing/assignments/{type}/{subjectId}", new { planId = (Guid?)null })).EnsureSuccessStatusCode();
        (await admin.DeleteAsync($"/api/billing/plans/{id}")).EnsureSuccessStatusCode();
        Assert.DoesNotContain(id.ToString(), await admin.GetStringAsync("/api/billing"));
        Assert.DoesNotContain(id.ToString(), await admin.GetStringAsync("/api/billing/plan-options"));
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PutAsJsonAsync($"/api/billing/assignments/{type}/{subjectId}", new { planId = id })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PutAsJsonAsync($"/api/billing/plans/{id}", new { name = "不能恢复", weeklyTokens = 1000 })).StatusCode);
        using var scope = factory.Services.CreateScope();
        Assert.NotNull((await scope.ServiceProvider.GetRequiredService<AigcHubDbContext>().TokenBillingPlans.IgnoreQueryFilters().SingleAsync(x => x.Id == id)).DeletedAt);
    }

    [Fact]
    public async Task UserManagementBatchQuotaMatchesBillingAndIncludesDisabledUsers()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);
        await AssignPlanAsync(admin, departmentId, "Department", 1000);
        (await admin.PostAsJsonAsync("/api/billing/packages", new { userId, tokens = 250, reason = "本周期增量" })).EnsureSuccessStatusCode();
        await GrantExternalModelAsync(factory, userId, "batch-model", "2x");
        var requestId = Guid.NewGuid();
        (await desktop.PostAsJsonAsync("/v1/billing/reservations", new { requestId, modelIdentifier = "batch-model", rawTokenBudget = 100 })).EnsureSuccessStatusCode();
        (await desktop.PutAsJsonAsync($"/v1/billing/reservations/{requestId}", new { inputTokens = 100, outputTokens = 50, totalTokens = 150 })).EnsureSuccessStatusCode();
        var response = await admin.PostAsJsonAsync("/api/billing/user-quotas", new[] { userId });
        response.EnsureSuccessStatusCode();
        var quota = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty(userId.ToString());
        Assert.Equal(1250, quota.GetProperty("total").GetInt64());
        Assert.Equal(150, quota.GetProperty("used").GetInt64());
        Assert.Equal(1100, quota.GetProperty("remaining").GetInt64());
        Assert.Equal("Department", quota.GetProperty("source").GetString());
        await AssignPlanAsync(admin, userId, "User", 2000);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            (await db.Users.SingleAsync(x => x.Id == userId)).IsEnabled = false;
            await db.SaveChangesAsync();
        }
        response = await admin.PostAsJsonAsync("/api/billing/user-quotas", new[] { userId });
        response.EnsureSuccessStatusCode();
        quota = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty(userId.ToString());
        Assert.Equal(2250, quota.GetProperty("total").GetInt64());
        Assert.Equal("User", quota.GetProperty("source").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/billing/user-quotas", Enumerable.Repeat(userId, 101).ToArray())).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/api/billing/user-quotas", new[] { userId })).StatusCode);
    }

    [Fact]
    public async Task PortalSelfServiceScopesPackagesToAuthenticatedUser()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        var (userId, _) = await SubjectAsync(factory);
        await AssignPlanAsync(admin, userId, "User", 1000);
        (await admin.PostAsJsonAsync("/api/billing/packages", new { userId, tokens = 250, reason = "临时增加" })).EnsureSuccessStatusCode();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            db.TokenIncrementPackages.Add(new TokenIncrementPackage { UserId = Guid.NewGuid(), Tokens = 999, Reason = "其他用户" });
            db.UserRoles.RemoveRange(await db.UserRoles.Where(x => x.UserId == userId).ToArrayAsync());
            await db.SaveChangesAsync();
        }
        using var user = await Login(factory, false);
        var result = await user.GetFromJsonAsync<JsonElement>($"/api/billing/me?userId={Guid.NewGuid()}");
        Assert.Equal(1250, result.GetProperty("quota").GetProperty("total").GetInt64());
        Assert.Equal(250, result.GetProperty("extraTokens").GetInt64());
        Assert.Equal(1, result.GetProperty("packages").GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/api/billing/packages")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync("/api/billing/user-quotas", new[] { userId })).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/billing/me")).StatusCode);
    }

    [Fact]
    public async Task PlansAndAssignmentsDrivePerUserQuotaWithPersonalOverride()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);

        var invalid = await admin.PostAsJsonAsync("/api/billing/plans", new { name = " ", weeklyTokens = 100 });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        var created = await admin.PostAsJsonAsync("/api/billing/plans", new { name = "标准", weeklyTokens = 1_000 });
        created.EnsureSuccessStatusCode();
        var planId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Conflict,
            (await admin.PostAsJsonAsync("/api/billing/plans", new { name = "标准", weeklyTokens = 1_000 })).StatusCode);

        // No plan assigned at all: external models stay unusable instead of defaulting to unlimited.
        var unassigned = await QuotaAsync(desktop); Assert.False(unassigned.GetProperty("assigned").GetBoolean());
        Assert.Equal(0, unassigned.GetProperty("total").GetInt64());

        (await admin.PutAsJsonAsync($"/api/billing/assignments/Department/{departmentId}", new { planId })).EnsureSuccessStatusCode();
        var inherited = await QuotaAsync(desktop);
        Assert.True(inherited.GetProperty("assigned").GetBoolean());
        Assert.Equal("Department", inherited.GetProperty("source").GetString());
        Assert.Equal(1_000, inherited.GetProperty("total").GetInt64());

        // A personal binding overrides the department plan without touching this week's usage.
        var personal = await admin.PostAsJsonAsync("/api/billing/plans", new { name = "高级", weeklyTokens = 5_000 });
        personal.EnsureSuccessStatusCode();
        var personalId = (await personal.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PutAsJsonAsync($"/api/billing/assignments/User/{userId}", new { planId = personalId })).EnsureSuccessStatusCode();
        var overridden = await QuotaAsync(desktop);
        Assert.Equal("User", overridden.GetProperty("source").GetString());
        Assert.Equal(5_000, overridden.GetProperty("total").GetInt64());

        // Removing the personal binding restores inheritance.
        (await admin.PutAsJsonAsync($"/api/billing/assignments/User/{userId}", new { planId = (Guid?)null })).EnsureSuccessStatusCode();
        Assert.Equal(1_000, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());

        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PutAsJsonAsync($"/api/billing/assignments/Team/{userId}", new { planId })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await admin.PutAsJsonAsync($"/api/billing/assignments/User/{Guid.NewGuid()}", new { planId })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await admin.PutAsJsonAsync($"/api/billing/assignments/User/{userId}", new { planId = Guid.NewGuid() })).StatusCode);

        // A disabled plan makes the assignment inert rather than silently generous.
        (await admin.PutAsJsonAsync($"/api/billing/plans/{planId}", new { name = "标准", weeklyTokens = 1_000, isEnabled = false })).EnsureSuccessStatusCode();
        Assert.False((await QuotaAsync(desktop)).GetProperty("assigned").GetBoolean());
    }

    [Fact]
    public async Task ExternalModelDisplayMultiplierDoesNotChangeSettlement()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, _) = await SubjectAsync(factory);
        await AssignPlanAsync(admin, userId, "User", 10_000);
        await GrantExternalModelAsync(factory, userId, "team-large", "2x");

        var quota = await QuotaAsync(desktop);
        Assert.Equal(10_000, quota.GetProperty("remaining").GetInt64());

        var requestId = Guid.NewGuid();
        var reserved = await desktop.PostAsJsonAsync("/v1/billing/reservations", new { requestId, modelIdentifier = "team-large", rawTokenBudget = 1_000 });
        reserved.EnsureSuccessStatusCode();
        var body = await reserved.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Pending", body.GetProperty("status").GetString());
        Assert.Equal(0, body.GetProperty("reservedTokens").GetInt64());
        Assert.Equal(1m, body.GetProperty("multiplier").GetDecimal());

        // Replaying the same admission is idempotent and must not reserve twice.
        var replay = await desktop.PostAsJsonAsync("/v1/billing/reservations", new { requestId, modelIdentifier = "team-large", rawTokenBudget = 1_000 });
        replay.EnsureSuccessStatusCode();
        Assert.Equal(0, (await replay.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("reservedTokens").GetInt64());
        var pending = await QuotaAsync(desktop);
        Assert.Equal(0, pending.GetProperty("reserved").GetInt64());
        Assert.Equal(10_000, pending.GetProperty("remaining").GetInt64());

        // A reservation issued before the display-only policy also settles at actual usage.
        using (var scope = factory.Services.CreateScope()) {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            (await db.TokenBillingEntries.SingleAsync(x => x.Id == requestId)).Multiplier = 2;
            await db.SaveChangesAsync();
        }
        var settled = await desktop.PutAsJsonAsync($"/v1/billing/reservations/{requestId}", new { inputTokens = 300, outputTokens = 200, totalTokens = 500 });
        settled.EnsureSuccessStatusCode();
        Assert.Equal(500, (await settled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("chargedTokens").GetInt64());
        var after = await QuotaAsync(desktop);
        Assert.Equal(500, after.GetProperty("used").GetInt64());
        Assert.Equal(0, after.GetProperty("reserved").GetInt64());

        // A duplicate settlement with the same usage is a no-op; a conflicting one is rejected.
        (await desktop.PutAsJsonAsync($"/v1/billing/reservations/{requestId}", new { inputTokens = 300, outputTokens = 200, totalTokens = 500 })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Conflict,
            (await desktop.PutAsJsonAsync($"/v1/billing/reservations/{requestId}", new { inputTokens = 301, outputTokens = 200, totalTokens = 501 })).StatusCode);
        Assert.Equal(500, (await QuotaAsync(desktop)).GetProperty("used").GetInt64());
    }

    [Fact]
    public async Task UnassignedQuotaUnauthorizedModelAndExhaustedBudgetAreRejected()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, _) = await SubjectAsync(factory);
        await GrantExternalModelAsync(factory, userId, "team-small", "");

        var noPlan = await desktop.PostAsJsonAsync("/v1/billing/reservations",
            new { requestId = Guid.NewGuid(), modelIdentifier = "team-small", rawTokenBudget = 100 });
        Assert.Equal(HttpStatusCode.PaymentRequired, noPlan.StatusCode);

        await AssignPlanAsync(admin, userId, "User", 500);
        var oversized = await desktop.PostAsJsonAsync("/v1/billing/reservations",
            new { requestId = Guid.NewGuid(), modelIdentifier = "team-small", rawTokenBudget = 5_000 });
        oversized.EnsureSuccessStatusCode();
        var admitted = await oversized.Content.ReadFromJsonAsync<JsonElement>();
        (await desktop.PutAsJsonAsync($"/v1/billing/reservations/{admitted.GetProperty("id").GetGuid()}",
            new { inputTokens = 550, outputTokens = 50, totalTokens = 600 })).EnsureSuccessStatusCode();
        Assert.Equal(0, (await QuotaAsync(desktop)).GetProperty("remaining").GetInt64());
        Assert.Equal(HttpStatusCode.PaymentRequired, (await desktop.PostAsJsonAsync("/v1/billing/reservations",
            new { requestId = Guid.NewGuid(), modelIdentifier = "team-small", rawTokenBudget = 1 })).StatusCode);

        var unknown = await desktop.PostAsJsonAsync("/v1/billing/reservations",
            new { requestId = Guid.NewGuid(), modelIdentifier = "not-granted", rawTokenBudget = 100 });
        Assert.Equal(HttpStatusCode.Forbidden, unknown.StatusCode);

        var malformed = await desktop.PostAsJsonAsync("/v1/billing/reservations",
            new { requestId = Guid.Empty, modelIdentifier = "team-small", rawTokenBudget = 100 });
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);

        // Internal models never reach the external ledger.
        Assert.Single((await ReportAsync(admin)).GetProperty("byModel").EnumerateArray());
    }

    [Fact]
    public async Task ReportAggregatesSettledUsageAndReleasesAbandonedReservations()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);
        await AssignPlanAsync(admin, userId, "User", 100_000);
        await GrantExternalModelAsync(factory, userId, "team-small", "");

        var settledId = Guid.NewGuid();
        (await desktop.PostAsJsonAsync("/v1/billing/reservations", new { requestId = settledId, modelIdentifier = "team-small", rawTokenBudget = 10_000 })).EnsureSuccessStatusCode();
        (await desktop.PutAsJsonAsync($"/v1/billing/reservations/{settledId}", new { inputTokens = 700, outputTokens = 300, totalTokens = 1_000 })).EnsureSuccessStatusCode();
        var abandonedId = Guid.NewGuid();
        (await desktop.PostAsJsonAsync("/v1/billing/reservations", new { requestId = abandonedId, modelIdentifier = "team-small", rawTokenBudget = 4_000 })).EnsureSuccessStatusCode();

        var report = await ReportAsync(admin);
        var byUser = Assert.Single(report.GetProperty("byUser").EnumerateArray());
        Assert.Equal(1_000, byUser.GetProperty("totalTokens").GetInt64());
        Assert.Equal(1, byUser.GetProperty("requests").GetInt32());
        Assert.Equal("wh00028", byUser.GetProperty("employeeNo").GetString());
        Assert.Equal(departmentId, byUser.GetProperty("departmentId").GetGuid());
        Assert.Equal(1_000, Assert.Single(report.GetProperty("byDepartment").EnumerateArray()).GetProperty("totalTokens").GetInt64());
        Assert.Equal("team-small", Assert.Single(report.GetProperty("byModel").EnumerateArray()).GetProperty("modelIdentifier").GetString());
        Assert.Equal(0, Assert.Single(report.GetProperty("pending").EnumerateArray()).GetProperty("reservedTokens").GetInt64());

        // Releasing a pending reservation requires a reconciliation note and returns the budget.
        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PostAsJsonAsync($"/api/billing/pending/{abandonedId}/release", new { reason = " " })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await admin.PostAsJsonAsync($"/api/billing/pending/{Guid.NewGuid()}/release", new { reason = "上游无记录" })).StatusCode);
        (await admin.PostAsJsonAsync($"/api/billing/pending/{abandonedId}/release", new { reason = "上游无记录" })).EnsureSuccessStatusCode();
        var released = await QuotaAsync(desktop);
        Assert.Equal(0, released.GetProperty("reserved").GetInt64());
        Assert.Equal(99_000, released.GetProperty("remaining").GetInt64());
        Assert.Empty((await ReportAsync(admin)).GetProperty("pending").EnumerateArray());

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.GetAsync("/api/billing/report?from=2026-01-01&to=2026-06-01")).StatusCode);
    }

    [Fact]
    public async Task BillingEndpointsRequireManagePermissionAndDesktopToken()
    {
        using var factory = new Factory();
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/billing")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/v1/billing/quota")).StatusCode);

        using var ordinary = factory.CreateClient();
        var login = await ordinary.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00412", password = "Bhss@123" });
        login.EnsureSuccessStatusCode();
        ordinary.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await ordinary.GetAsync("/api/billing")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden,
            (await ordinary.PostAsJsonAsync("/api/billing/plans", new { name = "越权", weeklyTokens = 1 })).StatusCode);
    }

    [Fact]
    public async Task UserAndDepartmentFormsBindPlansAndAPersonalPlanWins()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);

        var departmentPlan = await admin.PostAsJsonAsync("/api/billing/plans", new { name = "部门标准", weeklyTokens = 1_000 });
        departmentPlan.EnsureSuccessStatusCode();
        var departmentPlanId = (await departmentPlan.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var personalPlan = await admin.PostAsJsonAsync("/api/billing/plans", new { name = "个人高级", weeklyTokens = 9_000 });
        personalPlan.EnsureSuccessStatusCode();
        var personalPlanId = (await personalPlan.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        // The department form is the assignment surface: saving it binds the whole department.
        var department = await admin.GetFromJsonAsync<JsonElement>("/api/departments?page=1&pageSize=50");
        var stored = department.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == departmentId);
        Assert.Equal(JsonValueKind.Null, stored.GetProperty("billingPlanId").ValueKind);
        var saved = await admin.PutAsJsonAsync($"/api/departments/{departmentId}", new
        {
            code = stored.GetProperty("code").GetString(), name = stored.GetProperty("name").GetString(),
            description = stored.GetProperty("description").GetString(), managerId = (Guid?)null,
            isEnabled = true, billingPlanId = departmentPlanId,
        });
        saved.EnsureSuccessStatusCode();
        department = await admin.GetFromJsonAsync<JsonElement>("/api/departments?page=1&pageSize=50");
        Assert.Equal(departmentPlanId, department.GetProperty("items").EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == departmentId).GetProperty("billingPlanId").GetGuid());
        var inherited = await QuotaAsync(desktop);
        Assert.Equal("Department", inherited.GetProperty("source").GetString());
        Assert.Equal(1_000, inherited.GetProperty("total").GetInt64());

        // The user form overrides it for that one person.
        var users = await admin.GetFromJsonAsync<JsonElement>("/api/users?page=1&pageSize=500");
        var person = users.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == userId);
        var updated = await admin.PutAsJsonAsync($"/api/users/{userId}", new
        {
            employeeNo = person.GetProperty("employeeNo").GetString(), name = person.GetProperty("name").GetString(),
            email = person.GetProperty("email").GetString(), departmentId = (Guid?)departmentId,
            roleIds = person.GetProperty("roles").EnumerateArray().Select(x => x.GetProperty("roleId").GetGuid()).ToArray(),
            isEnabled = true, billingPlanId = personalPlanId,
        });
        updated.EnsureSuccessStatusCode();
        users = await admin.GetFromJsonAsync<JsonElement>("/api/users?page=1&pageSize=500");
        Assert.Equal(personalPlanId, users.GetProperty("items").EnumerateArray()
            .Single(x => x.GetProperty("id").GetGuid() == userId).GetProperty("billingPlanId").GetGuid());
        var overridden = await QuotaAsync(desktop);
        Assert.Equal("User", overridden.GetProperty("source").GetString());
        Assert.Equal(9_000, overridden.GetProperty("total").GetInt64());

        // Clearing the personal binding falls back to the department again.
        (await admin.PutAsJsonAsync($"/api/users/{userId}", new
        {
            employeeNo = person.GetProperty("employeeNo").GetString(), name = person.GetProperty("name").GetString(),
            email = person.GetProperty("email").GetString(), departmentId = (Guid?)departmentId,
            roleIds = Array.Empty<Guid>(), isEnabled = true, billingPlanId = (Guid?)null,
        })).EnsureSuccessStatusCode();
        Assert.Equal(1_000, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());

        // An unknown plan id must not silently drop the binding request.
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PutAsJsonAsync($"/api/users/{userId}", new
        {
            employeeNo = person.GetProperty("employeeNo").GetString(), name = person.GetProperty("name").GetString(),
            email = person.GetProperty("email").GetString(), departmentId = (Guid?)departmentId,
            roleIds = Array.Empty<Guid>(), isEnabled = true, billingPlanId = Guid.NewGuid(),
        })).StatusCode);
    }

    [Fact]
    public async Task PlanOptionsAreReadableByOrganizationEditorsOnly()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        (await admin.PostAsJsonAsync("/api/billing/plans", new { name = "标准", weeklyTokens = 2_000 })).EnsureSuccessStatusCode();
        var options = await admin.GetFromJsonAsync<JsonElement>("/api/billing/plan-options");
        var option = Assert.Single(options.EnumerateArray());
        Assert.Equal("标准", option.GetProperty("name").GetString());
        Assert.Equal(2_000, option.GetProperty("weeklyTokens").GetInt64());

        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/billing/plan-options")).StatusCode);
        using var ordinary = factory.CreateClient();
        var login = await ordinary.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00412", password = "Bhss@123" });
        login.EnsureSuccessStatusCode();
        ordinary.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await ordinary.GetAsync("/api/billing/plan-options")).StatusCode);
    }

    [Fact]
    public async Task PlanEditorSavesAssignmentsTogetherAndRejectsInvalidSubjects()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);
        var created = await admin.PostAsJsonAsync("/api/billing/plans", new {
            name = "授权配方", weeklyTokens = 1234, userIds = new[] { userId }, departmentIds = new[] { departmentId }
        });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal("User", (await QuotaAsync(desktop)).GetProperty("source").GetString());
        Assert.Equal(1234, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());
        var invalid = await admin.PutAsJsonAsync($"/api/billing/plans/{id}", new {
            name = "不应保存", weeklyTokens = 9999, userIds = new[] { Guid.NewGuid() }, departmentIds = Array.Empty<Guid>()
        });
        Assert.Equal(HttpStatusCode.NotFound, invalid.StatusCode);
        Assert.Equal(1234, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());
        (await admin.PutAsJsonAsync($"/api/billing/plans/{id}", new {
            name = "授权配方", weeklyTokens = 2000, userIds = Array.Empty<Guid>(), departmentIds = new[] { departmentId }
        })).EnsureSuccessStatusCode();
        Assert.Equal("Department", (await QuotaAsync(desktop)).GetProperty("source").GetString());
        (await admin.PutAsJsonAsync($"/api/billing/plans/{id}", new { name = "授权配方", weeklyTokens = 3000 })).EnsureSuccessStatusCode();
        Assert.Equal("Department", (await QuotaAsync(desktop)).GetProperty("source").GetString());
        Assert.Equal(3000, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());
    }

    [Fact]
    public async Task IncrementPackagesAddOnlyCurrentPeriodAndKeepHistory()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var (userId, departmentId) = await SubjectAsync(factory);
        await AssignPlanAsync(admin, departmentId, "Department", 5_000_000);
        var before = await QuotaAsync(desktop);
        var response = await admin.PostAsJsonAsync("/api/billing/packages", new { userId, tokens = 1_000_000, reason = "项目临时追加" });
        response.EnsureSuccessStatusCode();
        var after = await QuotaAsync(desktop);
        Assert.Equal(6_000_000, after.GetProperty("total").GetInt64());
        Assert.Equal(before.GetProperty("resetsAt").GetString(), after.GetProperty("resetsAt").GetString());
        Assert.Equal("Department", after.GetProperty("source").GetString());
        (await admin.PostAsJsonAsync("/api/billing/packages", new { userId, tokens = 500_000, reason = "再次追加" })).EnsureSuccessStatusCode();
        Assert.Equal(6_500_000, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync("/api/billing/packages", new { userId, tokens = -1, reason = "错误" })).StatusCode);
        var history = await admin.GetFromJsonAsync<JsonElement>("/api/billing/packages?page=1&pageSize=1&keyword=追加");
        Assert.Equal(2, history.GetProperty("total").GetInt32());
        Assert.Single(history.GetProperty("items").EnumerateArray());
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            foreach (var package in await db.TokenIncrementPackages.ToListAsync())
            {
                package.WeekStart = package.WeekStart.AddDays(-7);
                package.ExpiresAt = package.ExpiresAt.AddDays(-7);
            }
            await db.SaveChangesAsync();
        }
        Assert.Equal(5_000_000, (await QuotaAsync(desktop)).GetProperty("total").GetInt64());
        Assert.Equal(2, (await admin.GetFromJsonAsync<JsonElement>("/api/billing/packages")).GetProperty("total").GetInt32());
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/billing/packages")).StatusCode);
    }

    [Fact]
    public async Task NewUsersReceiveEnabledLocalModelsEvenWithEmptySelection()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        Guid enabledId, disabledId, externalId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var enabled = new AiModelConfiguration { BaseUrl="http://localhost/v1", ModelIdentifier=Guid.NewGuid().ToString(), Name="默认本地", ProviderKind="Local", IsEnabled=true };
            var disabled = new AiModelConfiguration { BaseUrl="http://localhost/v1", ModelIdentifier=Guid.NewGuid().ToString(), Name="停用本地", ProviderKind="Local", IsEnabled=false };
            var external = new AiModelConfiguration { BaseUrl="http://localhost/v1", ModelIdentifier=Guid.NewGuid().ToString(), Name="外部", ProviderKind="LiteLLM", IsEnabled=true };
            db.ModelConfigurations.AddRange(enabled, disabled, external);
            await db.SaveChangesAsync();
            enabledId=enabled.Id; disabledId=disabled.Id; externalId=external.Id;
        }
        var response = await admin.PostAsJsonAsync("/api/users", new {
            employeeNo="new-local",name="新用户",email="new-local@example.test",roleIds=Array.Empty<Guid>(),modelIds=Array.Empty<Guid>(),isEnabled=true
        });
        response.EnsureSuccessStatusCode();
        var id=(await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        using var check = factory.Services.CreateScope();
        var grants=await check.ServiceProvider.GetRequiredService<AigcHubDbContext>().UserModelGrants.Where(x=>x.UserId==id).Select(x=>x.ModelId).ToArrayAsync();
        Assert.Contains(enabledId,grants);
        Assert.DoesNotContain(disabledId,grants);
        Assert.DoesNotContain(externalId,grants);
    }

    private static async Task<JsonElement> QuotaAsync(HttpClient client)
    {
        var quota = await client.GetFromJsonAsync<JsonElement>("/v1/billing/quota");
        return quota;
    }

    private static async Task<JsonElement> ReportAsync(HttpClient client)
    {
        var report = await client.GetFromJsonAsync<JsonElement>("/api/billing/report");
        return report;
    }

    private static async Task<(Guid UserId, Guid DepartmentId)> SubjectAsync(Factory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var user = await db.Users.AsNoTracking().SingleAsync(x => x.EmployeeNo == "wh00028");
        return (user.Id, user.DepartmentId!.Value);
    }

    private static async Task AssignPlanAsync(HttpClient admin, Guid userId, string type, long weeklyTokens)
    {
        var created = await admin.PostAsJsonAsync("/api/billing/plans", new { name = $"配方-{weeklyTokens}", weeklyTokens });
        created.EnsureSuccessStatusCode();
        var planId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PutAsJsonAsync($"/api/billing/assignments/{type}/{userId}", new { planId })).EnsureSuccessStatusCode();
    }

    /// <summary>Grant one LiteLLM model directly so admission resolves a multiplier without a virtual key.</summary>
    private static async Task GrantExternalModelAsync(Factory factory, Guid userId, string identifier, string multiplier)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var model = new AiModelConfiguration
        {
            Name = identifier, ProviderKind = "LiteLLM", BaseUrl = "https://model.example.test/v1",
            ModelIdentifier = identifier, AuthType = "None", IsEnabled = true, Multiplier = multiplier,
        };
        db.ModelConfigurations.Add(model);
        db.UserModelGrants.Add(new UserModelGrant { UserId = userId, ModelId = model.Id });
        await db.SaveChangesAsync();
    }

    /// <summary>Administrator console session, or the desktop session that owns <c>/v1/billing</c>.</summary>
    private static async Task<HttpClient> Login(Factory factory, bool desktop)
    {
        var client = factory.CreateClient();
        var response = desktop
            ? await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" })
            : await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            body.GetProperty(desktop ? "access_token" : "accessToken").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "token-billing-" + Guid.NewGuid().ToString("N"));
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(root));
            });
        }
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
