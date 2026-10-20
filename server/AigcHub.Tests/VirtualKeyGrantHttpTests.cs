using System.Net;
using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public class VirtualKeyGrantHttpTests
{
    [Fact]
    public async Task Password_changes_require_current_password_or_administrator_and_revoke_desktop_sessions()
    {
        using var factory = new Factory(); using var admin = await Login(factory);
        var created = await admin.PostAsJsonAsync("/api/users", new { employeeNo = "password-test", name = "密码测试", email = "password@test.local",
            password = "Old-local-123", departmentId = (Guid?)null, roleIds = Array.Empty<Guid>(), isEnabled = true });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        using var ordinary = factory.CreateClient();
        var login = await ordinary.PostAsJsonAsync("/api/auth/login", new { employeeNo = "password-test", password = "Old-local-123" });
        login.EnsureSuccessStatusCode();
        ordinary.DefaultRequestHeaders.Authorization = new("Bearer", (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await ordinary.PutAsJsonAsync($"/api/users/{id}/password", new { newPassword = "Unauthorized-123" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ordinary.PutAsJsonAsync("/api/auth/password", new { currentPassword = "wrong", newPassword = "New-local-123" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await ordinary.PutAsJsonAsync("/api/auth/password", new { currentPassword = "Old-local-123", newPassword = "short" })).StatusCode);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            db.DshPersistentSessions.Add(new() { UserId = id, RefreshTokenHash = "test-refresh-hash" });
            db.DshAccessTokens.Add(new() { UserId = id, TokenHash = "test-access-hash", ExpiresAt = DateTimeOffset.UtcNow.AddHours(1) });
            await db.SaveChangesAsync();
        }
        (await ordinary.PutAsJsonAsync("/api/auth/password", new { currentPassword = "Old-local-123", newPassword = "New-local-123" })).EnsureSuccessStatusCode();
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PutAsJsonAsync("/api/auth/password", new { currentPassword = "New-local-123", newPassword = "Other-local-123" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/api/auth/login", new { employeeNo = "password-test", password = "Old-local-123" })).StatusCode);
        (await anonymous.PostAsJsonAsync("/api/auth/login", new { employeeNo = "password-test", password = "New-local-123" })).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync($"/api/users/{id}/password", new { newPassword = "Admin-reset-123" })).EnsureSuccessStatusCode();
        (await anonymous.PostAsJsonAsync("/api/auth/login", new { employeeNo = "password-test", password = "Admin-reset-123" })).EnsureSuccessStatusCode();
        using var checkScope = factory.Services.CreateScope(); var check = checkScope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.False(await check.DshAccessTokens.AnyAsync(x => x.UserId == id));
        Assert.True((await check.DshPersistentSessions.SingleAsync(x => x.UserId == id)).Revoked);
        var stored = (await check.Users.SingleAsync(x => x.Id == id)).PasswordHash;
        Assert.DoesNotContain("Admin-reset-123", stored);
        Assert.All(await check.OperationAudits.Where(x => x.EntityId == id.ToString()).ToArrayAsync(), audit => Assert.Equal("{}", audit.DetailJson));
    }

    [Fact]
    public async Task User_administration_saves_direct_models_and_key_without_a_department_and_old_clients_preserve_grants()
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, "None", false);
        var model = new AiModelConfiguration { Name = "用户授权测试", BaseUrl = "http://test", ModelIdentifier = "test", AuthType = "None", Multiplier = "0.5×" };
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            db.ModelConfigurations.Add(model); await db.SaveChangesAsync();
        }
        var response = await admin.PostAsJsonAsync("/api/users", new {
            employeeNo = "access-test", name = "未分配部门用户", email = "access@test.local", departmentId = (Guid?)null,
            roleIds = Array.Empty<Guid>(), isEnabled = true, modelIds = new[] { model.Id }, virtualKeyIds = new[] { seed.A }
        });
        response.EnsureSuccessStatusCode();
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var options = await admin.GetFromJsonAsync<JsonElement>($"/api/users/access-options?userId={id}");
        Assert.DoesNotContain("KeyProtected", options.ToString());
        Assert.True(options.GetProperty("models").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == model.Id).GetProperty("selected").GetBoolean());
        Assert.True(options.GetProperty("virtualKeys").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == seed.A).GetProperty("selected").GetBoolean());
        (await admin.PutAsJsonAsync($"/api/users/{id}", new {
            employeeNo = "access-test", name = "更新姓名", email = "access@test.local", departmentId = (Guid?)null,
            roleIds = Array.Empty<Guid>(), isEnabled = true
        })).EnsureSuccessStatusCode();
        using var finalScope = factory.Services.CreateScope();
        var finalDb = finalScope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.Null((await finalDb.Users.SingleAsync(x => x.Id == id)).DepartmentId);
        Assert.True(await finalDb.UserModelGrants.AnyAsync(x => x.UserId == id && x.ModelId == model.Id));
        Assert.True(await finalDb.AccessGrants.AnyAsync(x => x.SubjectId == id && x.ResourceKey == $"virtual-key:{seed.A:D}"));
        (await admin.PutAsJsonAsync($"/api/users/{id}", new {
            employeeNo = "access-test", name = "更新姓名", email = "access@test.local", departmentId = seed.Department,
            roleIds = Array.Empty<Guid>(), isEnabled = true, modelIds = Array.Empty<Guid>(), virtualKeyIds = new[] { seed.B }
        })).EnsureSuccessStatusCode();
        using var checkScope = factory.Services.CreateScope();
        var check = checkScope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.Equal(seed.Department, (await check.Users.SingleAsync(x => x.Id == id)).DepartmentId);
        Assert.False(await check.UserModelGrants.AnyAsync(x => x.UserId == id));
        Assert.Equal($"virtual-key:{seed.B:D}", (await check.AccessGrants.SingleAsync(x => x.SubjectId == id)).ResourceKey);
    }

    [Fact]
    public async Task User_direct_key_selection_cannot_override_inherited_membership()
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, "Department", false);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var user = await db.Users.Include(x => x.Roles).SingleAsync(x => x.Id == seed.User);
        var response = await admin.PutAsJsonAsync($"/api/users/{user.Id}", new {
            user.EmployeeNo, user.Name, user.Email, user.DepartmentId, user.IsEnabled,
            roleIds = user.Roles.Select(x => x.RoleId).ToArray(), virtualKeyIds = new[] { seed.B }
        });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.False(await db.AccessGrants.AnyAsync(x => x.SubjectType == "User" && x.SubjectId == user.Id && x.ResourceKey == $"virtual-key:{seed.B:D}"));
    }

    [Theory]
    [InlineData(3, 3)]
    [InlineData(0, 1)]
    [InlineData(101, 100)]
    public async Task Audit_pagination_honors_custom_sizes(int requested, int expected)
    {
        using var factory = new Factory(); using var admin = await Login(factory);
        var result = await admin.GetFromJsonAsync<JsonElement>($"/api/operation-audits?page=1&pageSize={requested}");
        Assert.Equal(expected, result.GetProperty("pageSize").GetInt32());
    }

    [Fact]
    public async Task Admin_can_create_and_edit_gateway_policy_without_receiving_key_material()
    {
        var gateway = new PolicyGateway();
        using var factory = new Factory(gateway);
        using var admin = await Login(factory);
        Assert.Equal(new[] { "glm-5.3-flash" }, await admin.GetFromJsonAsync<string[]>("/api/virtual-keys/model-options"));
        var created = await admin.PostAsJsonAsync("/api/virtual-keys", new { alias = "套餐测试", policy = new {
            models = new[] { "glm-5.3-flash" }, allModels = false, maxBudget = 0, budgetDuration = "30d", rpmLimit = 10, tpmLimit = 20000,
        } });
        created.EnsureSuccessStatusCode();
        var text = await created.Content.ReadAsStringAsync();
        Assert.DoesNotContain("sk-", text);
        using var body = JsonDocument.Parse(text);
        var id = body.RootElement.GetProperty("id").GetGuid();
        var current = await admin.GetFromJsonAsync<JsonElement>($"/api/virtual-keys/{id}/policy");
        Assert.Equal(0, current.GetProperty("maxBudget").GetDecimal());
        Assert.Equal("30d", current.GetProperty("budgetDuration").GetString());
        Assert.DoesNotContain("secret", current.ToString());
        var update = await admin.PutAsJsonAsync($"/api/virtual-keys/{id}/policy", new {
            models = new[] { "glm-5.3-flash" }, allModels = false, maxBudget = 0, budgetDuration = "30d", rpmLimit = 20, tpmLimit = 20000,
        });
        update.EnsureSuccessStatusCode();
        var final = await update.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(20, final.GetProperty("rpmLimit").GetInt32());
        Assert.False(gateway.Update!.ContainsKey("duration"));
        Assert.False(gateway.Update.ContainsKey("budget_duration"));
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.DoesNotContain("sk-policy-secret", (await db.ManagedVirtualKeys.SingleAsync()).KeyProtected);
        Assert.True(await db.OperationAudits.AnyAsync(x => x.Action == "virtual-key.policy"));
        Assert.False(await db.OperationAudits.AnyAsync(x => x.DetailJson.Contains("sk-policy-secret")));
    }

    [Theory]
    [InlineData("User", "User", false)]
    [InlineData("Department", "User", false)]
    [InlineData("Role", "Department", false)]
    [InlineData("Organization", "Role", false)]
    [InlineData("User", "User", true)]
    public async Task Occupied_members_are_disabled_and_all_grant_paths_reject_overlap(string existing, string proposed, bool disabled)
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, existing, disabled);
        var options = await admin.GetFromJsonAsync<JsonElement>($"/api/virtual-keys/grant-options?keyId={seed.B}");
        var user = options.GetProperty("users").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == seed.User);
        Assert.True(user.GetProperty("disabled").GetBoolean());
        Assert.Contains("原 Key 组", user.GetProperty("disabledReason").GetString());
        var own = await admin.GetFromJsonAsync<JsonElement>($"/api/virtual-keys/grant-options?keyId={seed.A}");
        Assert.False(own.GetProperty("users").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == seed.User).GetProperty("disabled").GetBoolean());
        var rejected = await admin.PutAsJsonAsync($"/api/virtual-keys/{seed.B}/grants", Selection(seed, proposed));
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Assert.Contains("原 Key 组", await rejected.Content.ReadAsStringAsync());
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            Assert.False(await db.AccessGrants.AnyAsync(x => x.ResourceKey == $"virtual-key:{seed.B:D}"));
        }
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{seed.A}/grants", Selection(seed, "None"))).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{seed.B}/grants", Selection(seed, proposed))).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Concurrent_assignments_cannot_put_one_user_in_two_keys()
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, "None", false);
        var responses = await Task.WhenAll(
            admin.PutAsJsonAsync($"/api/virtual-keys/{seed.A}/grants", Selection(seed, "User")),
            admin.PutAsJsonAsync($"/api/virtual-keys/{seed.B}/grants", Selection(seed, "User")));
        Assert.Single(responses, x => x.StatusCode == HttpStatusCode.NoContent);
        Assert.Single(responses, x => x.StatusCode == HttpStatusCode.Conflict);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.Equal(1, await db.AccessGrants.CountAsync(x => x.ResourceKey.StartsWith("virtual-key:") && x.SubjectId == seed.User));
    }

    [Fact]
    public async Task Existing_overlaps_can_be_removed_but_cannot_be_enabled_or_extended_through_legacy_groups()
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, "User", false);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            (await db.ManagedVirtualKeys.SingleAsync(x => x.Id == seed.B)).IsEnabled = false;
            db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{seed.B:D}", SubjectType = "User", SubjectId = seed.User });
            await db.SaveChangesAsync();
        }
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PutAsync($"/api/virtual-keys/{seed.B}/enabled?enabled=true", null)).StatusCode);
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{seed.B}/grants", Selection(seed, "None"))).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{seed.B}/grants", Selection(seed, "Organization"))).EnsureSuccessStatusCode();
        // This old group is initially empty. Adding the occupied user must also be rejected.
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PutAsJsonAsync($"/api/virtual-keys/organizations/{seed.Organization}",
            new { name = "旧分组", userIds = new[] { seed.User } })).StatusCode);
    }

    [Fact]
    public async Task Changing_user_roles_cannot_introduce_indirect_membership_in_two_keys()
    {
        using var factory = new Factory();
        using var admin = await Login(factory);
        var seed = await Seed(factory, "Department", false);
        Guid roleId;
        object input;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var role = new Role { Code = "exclusive-test", Name = "独占套餐角色" };
            roleId = role.Id;
            db.Roles.Add(role);
            db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{seed.B:D}", SubjectType = "Role", SubjectId = role.Id });
            await db.SaveChangesAsync();
            var user = await db.Users.Include(x => x.Roles).SingleAsync(x => x.Id == seed.User);
            input = new { user.EmployeeNo, user.Name, user.Email, user.DepartmentId,
                roleIds = user.Roles.Select(x => x.RoleId).Append(role.Id).ToArray(), user.IsEnabled };
        }
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PutAsJsonAsync($"/api/users/{seed.User}", input)).StatusCode);
        using var finalScope = factory.Services.CreateScope();
        Assert.False(await finalScope.ServiceProvider.GetRequiredService<AigcHubDbContext>().UserRoles
            .AnyAsync(x => x.UserId == seed.User && x.RoleId == roleId));
    }

    [Fact]
    public async Task Management_routes_require_login()
    {
        using var factory = new Factory();
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/virtual-keys/model-options")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/virtual-keys/grant-options")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PutAsJsonAsync($"/api/virtual-keys/{Guid.NewGuid()}/policy", new { })).StatusCode);
    }

    private sealed record State(Guid User, Guid Department, Guid Role, Guid Organization, Guid A, Guid B);
    private static object Selection(State value, string type) => new
    {
        userIds = type == "User" ? new[] { value.User } : [],
        departmentIds = type == "Department" ? new[] { value.Department } : [],
        roleIds = type == "Role" ? new[] { value.Role } : [],
        organizationIds = type == "Organization" ? new[] { value.Organization } : []
    };
    private static async Task<State> Seed(Factory factory, string type, bool disabled)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var user = await db.Users.Include(x => x.Roles).SingleAsync(x => x.EmployeeNo == "wh00028");
        var a = new ManagedVirtualKey { Alias = "原 Key 组", KeyProtected = "unused", IsEnabled = !disabled };
        var b = new ManagedVirtualKey { Alias = "新 Key 组", KeyProtected = "unused" };
        var organization = new VirtualKeyOrganization { Name = "旧分组" };
        db.ManagedVirtualKeys.AddRange(a, b);
        db.VirtualKeyOrganizations.Add(organization);
        var state = new State(user.Id, user.DepartmentId!.Value, user.Roles.First().RoleId, organization.Id, a.Id, b.Id);
        if (type != "None") db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{a.Id:D}", SubjectType = type,
            SubjectId = type switch { "User" => state.User, "Department" => state.Department, "Role" => state.Role, _ => state.Organization } });
        if (type == "Organization") db.VirtualKeyOrganizationMembers.Add(new() { OrganizationId = organization.Id, UserId = user.Id });
        await db.SaveChangesAsync();
        return state;
    }
    private static async Task<HttpClient> Login(Factory factory)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.GetProperty("accessToken").GetString());
        return client;
    }
    private sealed class PolicyGateway : HttpMessageHandler
    {
        private readonly JsonObject info = JsonNode.Parse("{\"models\":[],\"max_budget\":null,\"budget_duration\":null,\"rpm_limit\":null,\"tpm_limit\":null,\"expires\":null,\"token\":\"secret-hash\"}")!.AsObject();
        public JsonObject? Update;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.Method == HttpMethod.Post)
            {
                var payload = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                if (request.RequestUri!.AbsolutePath == "/key/update") Update = payload;
                foreach (var field in new[] { "models", "max_budget", "budget_duration", "rpm_limit", "tpm_limit" })
                    if (payload.ContainsKey(field)) info[field] = payload[field]?.DeepClone();
                return new(HttpStatusCode.OK) { Content = new StringContent("{\"key\":\"sk-policy-secret\"}") };
            }
            var json = request.RequestUri!.AbsolutePath == "/v1/models" ? "{\"data\":[{\"id\":\"glm-5.3-flash\"}]}"
                : JsonSerializer.Serialize(new { info });
            return new(HttpStatusCode.OK) { Content = new StringContent(json) };
        }
    }

    private sealed class Factory(HttpMessageHandler? upstream = null) : WebApplicationFactory<Program>
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), $"virtual-key-{Guid.NewGuid():N}");
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("LiteLlm:BaseUrl", "https://proxy.test/v1");
            builder.UseSetting("LiteLlm:ManagementApiKey", "test-management");
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.UseSetting("FileLogging:Directory", Path.Combine(root, "logs"));
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(root));
                if (upstream is not null) services.AddHttpClient("litellm-key-management").ConfigurePrimaryHttpMessageHandler(() => upstream);
            });
        }
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
