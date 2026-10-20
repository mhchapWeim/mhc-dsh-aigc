using System.Net;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public sealed class ModelGrantTests
{
    [Fact]
    public async Task Dsh_uses_bound_virtual_key_without_creating_session_keys()
    {
        var handler = new VirtualKeyHandler();
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        await SeedData.InitializeAsync(db);
        var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var protector = new EphemeralDataProtectionProvider();
        var service = new LiteLlmVirtualKeyService(new StubHttpClientFactory(handler),
            Options.Create(new LiteLlmOptions
            {
                BaseUrl = "http://litellm.test/v1", PublicBaseUrl = "http://litellm.test/v1",
                ManagementApiKey = "sk-admin"
            }), db, protector, NullLogger<LiteLlmVirtualKeyService>.Instance);
        var protectedKey = await service.CreateAsync("test-key", null, default);
        var key = new ManagedVirtualKey { Alias = "test-key", KeyProtected = protectedKey };
        db.ManagedVirtualKeys.Add(key);
        db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{key.Id:D}", SubjectType = "User", SubjectId = user.Id });
        await db.SaveChangesAsync();

        var first = await service.GetAsync(user.Id, default);
        var second = await service.GetAsync(user.Id, default);

        Assert.Null(first.ExpiresAt);
        Assert.Equal(first, second);
        Assert.Equal(1, handler.RequestCount);
        Assert.Equal("test-key", handler.RequestBody!.RootElement.GetProperty("key_alias").GetString());
        await service.SetBlockedAsync(protectedKey, true, default);
        Assert.EndsWith("/key/block", handler.RequestUri);
        Assert.Equal("sk-user-test", handler.RequestBody!.RootElement.GetProperty("key").GetString());
    }

    [Fact]
    public async Task Organization_and_department_bindings_share_one_key_and_reject_overlaps()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        await SeedData.InitializeAsync(db);
        var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var protection = new EphemeralDataProtectionProvider();
        var protector = protection.CreateProtector("AigcHub.ManagedVirtualKey.v1");
        var service = new LiteLlmVirtualKeyService(new StubHttpClientFactory(new VirtualKeyHandler()),
            Options.Create(new LiteLlmOptions { PublicBaseUrl = "http://litellm.test/v1" }),
            db, protection, NullLogger<LiteLlmVirtualKeyService>.Instance);
        var organization = new VirtualKeyOrganization { Name = "研究组" };
        db.VirtualKeyOrganizations.Add(organization);
        db.VirtualKeyOrganizationMembers.Add(new VirtualKeyOrganizationMember { OrganizationId = organization.Id, UserId = user.Id });
        var shared = new ManagedVirtualKey { Alias = "shared", KeyProtected = protector.Protect("sk-shared") };
        db.ManagedVirtualKeys.Add(shared);
        db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{shared.Id:D}", SubjectType = "Organization", SubjectId = organization.Id });
        await db.SaveChangesAsync();
        Assert.Equal("sk-shared", (await service.GetAsync(user.Id, default)).ApiKey);

        var second = new ManagedVirtualKey { Alias = "department", KeyProtected = protector.Protect("sk-dept") };
        db.ManagedVirtualKeys.Add(second);
        db.AccessGrants.Add(new AccessGrant { ResourceKey = $"virtual-key:{second.Id:D}", SubjectType = "Department", SubjectId = user.DepartmentId!.Value });
        await db.SaveChangesAsync();
        var error = await Assert.ThrowsAsync<WorkflowException>(() => service.GetAsync(user.Id, default));
        Assert.Equal(409, error.StatusCode);
    }

    [Fact]
    public async Task Role_and_department_grants_apply_to_models_and_web_search()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        await SeedData.InitializeAsync(db);
        var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var roleId = await db.UserRoles.Where(x => x.UserId == user.Id).Select(x => x.RoleId).SingleAsync();
        var model = new AiModelConfiguration
        {
            Name = "部门模型", BaseUrl = "http://model.test", ModelIdentifier = "stub",
            AuthType = "None", IsEnabled = true
        };
        db.ModelConfigurations.Add(model);
        await db.SaveChangesAsync();
        var grants = new AccessGrantService(db);
        var service = new ModelConfigurationService(db, grants, new EphemeralDataProtectionProvider(),
            Options.Create(new ChatOptions()));

        await grants.SetAsync(AccessGrantService.ModelKey(model.Id), new([], [roleId], []), default);
        Assert.Equal(model.Id, Assert.Single(await service.AvailableAsync(user.Id, default)).Id);
        Assert.Equal(model.Id, (await service.ResolveGrantedAsync(user.Id, model.Id, default))!.Id);

        await grants.SetAsync(AccessGrantService.ModelKey(model.Id), new([], [], [user.DepartmentId!.Value]), default);
        Assert.Equal(model.Id, Assert.Single(await service.AvailableAsync(user.Id, default)).Id);

        await grants.SetAsync(AccessGrantService.WebSearchKey, new([], [], [user.DepartmentId!.Value]), default);
        Assert.True(await grants.AllowsAsync(AccessGrantService.WebSearchKey, user.Id, default));
        var department = await db.Departments.SingleAsync(x => x.Id == user.DepartmentId!.Value);
        department.IsEnabled = false;
        await db.SaveChangesAsync();
        Assert.False(await grants.AllowsAsync(AccessGrantService.WebSearchKey, user.Id, default));
        Assert.Empty(await service.AvailableAsync(user.Id, default));
    }

    [Fact]
    public async Task LiteLlm_sync_upserts_catalog_and_disables_missing_models_without_deleting_them()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        db.ModelConfigurations.Add(new AiModelConfiguration
        {
            Name = "旧模型", ProviderKind = "LiteLLM", BaseUrl = "http://old-gateway.test/v1",
            ModelIdentifier = "removed", AuthType = "None", IsEnabled = true, IsDefault = true
        });
        await db.SaveChangesAsync();
        var handler = new CatalogHandler();
        var protection = new EphemeralDataProtectionProvider();
        var liteLlm = Options.Create(new LiteLlmOptions
        {
            BaseUrl = "http://gateway.test/v1/", ApiKey = "sk-sync"
        });
        var service = new LiteLlmModelSyncService(db, protection, new StubHttpClientFactory(handler), liteLlm);

        var first = await service.SynchronizeAsync(default);

        Assert.Equal(new LiteLlmModelSyncResult(2, 2, 0, 1), first);
        Assert.Equal("http://gateway.test/v1/models", handler.RequestUri);
        Assert.Equal("Bearer sk-sync", handler.Authorization);
        var removed = await db.ModelConfigurations.SingleAsync(x => x.ModelIdentifier == "removed");
        Assert.False(removed.IsEnabled);
        Assert.False(removed.IsDefault);
        Assert.Equal("http://gateway.test/v1", removed.BaseUrl);
        Assert.Equal(3, await db.ModelConfigurations.CountAsync());
        var synced = await db.ModelConfigurations.SingleAsync(x => x.ModelIdentifier == "alpha");
        Assert.False(synced.IsEnabled);
        Assert.Empty(await db.UserModelGrants.ToListAsync());
        synced.IsEnabled = true;
        await db.SaveChangesAsync();
        var resolved = await new ModelConfigurationService(db, protection, Options.Create(new ChatOptions()))
            .ResolveAsync(synced.Id, default);
        Assert.Equal("sk-sync", resolved!.ApiKey);

        var second = await service.SynchronizeAsync(default);
        Assert.Equal(new LiteLlmModelSyncResult(2, 0, 2, 0), second);
        Assert.Equal(3, await db.ModelConfigurations.CountAsync());
    }

    [Fact]
    public async Task LiteLlm_gateway_can_be_saved_as_an_openai_compatible_model()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        var service = new ModelConfigurationService(db, new EphemeralDataProtectionProvider(),
            Options.Create(new ChatOptions()));

        var saved = await service.SaveAsync(null, new(
            "LiteLLM 默认模型", "LiteLLM", "http://localhost:4000/v1", "/chat/completions",
            "aigc-default", "sk-test", "Bearer", "X-API-Key", true, true, true, 0.3, null, 0), default);

        var resolved = await service.ResolveAsync(saved.Id, default);
        Assert.NotNull(resolved);
        Assert.Equal("LiteLLM", resolved.ProviderKind);
        Assert.Equal("http://localhost:4000/v1", resolved.BaseUrl);
        Assert.Equal("/chat/completions", resolved.EndpointPath);
        Assert.Equal("aigc-default", resolved.ModelIdentifier);
        Assert.Equal("sk-test", resolved.ApiKey);
    }

    [Fact]
    public async Task Missing_data_protection_key_returns_an_actionable_model_error()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        var originalProtection = new EphemeralDataProtectionProvider();
        var currentProtection = new EphemeralDataProtectionProvider();
        db.ModelConfigurations.Add(new AiModelConfiguration
        {
            Name = "旧密钥模型", ProviderKind = "LiteLLM", BaseUrl = "http://localhost:4000/v1",
            EndpointPath = "/chat/completions", ModelIdentifier = "aigc-default", AuthType = "Bearer",
            ApiKeyProtected = originalProtection.CreateProtector("AigcHub.ModelApiKeys.v1").Protect("sk-old"),
            IsEnabled = true
        });
        await db.SaveChangesAsync();
        var service = new ModelConfigurationService(db, currentProtection, Options.Create(new ChatOptions()));

        var error = await Assert.ThrowsAsync<WorkflowException>(() =>
            service.ResolveAsync(db.ModelConfigurations.Single().Id, default));

        Assert.Equal(503, error.StatusCode);
        Assert.Contains("重新同步 LiteLLM", error.Message);
    }

    [Fact]
    public async Task Catalog_and_generation_resolution_recheck_the_current_user_grant()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        await using var db = new AigcHubDbContext(options);
        await SeedData.InitializeAsync(db);
        var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var model = new AiModelConfiguration
        {
            Name = "仅授权模型", BaseUrl = "http://model.test", ModelIdentifier = "stub",
            AuthType = "None", IsEnabled = true
        };
        db.ModelConfigurations.Add(model);
        await db.SaveChangesAsync();
        var service = new ModelConfigurationService(db, new EphemeralDataProtectionProvider(),
            Options.Create(new ChatOptions()));

        Assert.Empty(await service.AvailableAsync(user.Id, default));
        var denied = await Assert.ThrowsAsync<WorkflowException>(() => service.ResolveGrantedAsync(user.Id, model.Id, default));
        Assert.Equal(403, denied.StatusCode);

        await service.SetGrantedUsersAsync(model.Id, [user.Id], default);
        Assert.Equal(model.Id, Assert.Single(await service.AvailableAsync(user.Id, default)).Id);
        Assert.Equal(model.Id, (await service.ResolveGrantedAsync(user.Id, model.Id, default))!.Id);

        await service.SetGrantedUsersAsync(model.Id, [], default);
        Assert.Empty(await service.AvailableAsync(user.Id, default));
        denied = await Assert.ThrowsAsync<WorkflowException>(() => service.ResolveGrantedAsync(user.Id, model.Id, default));
        Assert.Equal(403, denied.StatusCode);
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class VirtualKeyHandler : HttpMessageHandler
    {
        public string? RequestUri { get; private set; }
        public int RequestCount { get; private set; }
        public JsonDocument? RequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestCount++;
            RequestUri = request.RequestUri?.ToString();
            RequestBody = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"key":"sk-user-test","expires":null}""")
            };
        }
    }

    private sealed class CatalogHandler : HttpMessageHandler
    {
        public string? RequestUri { get; private set; }
        public string? Authorization { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            RequestUri = request.RequestUri?.ToString();
            Authorization = request.Headers.Authorization?.ToString();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"data":[{"id":"beta"},{"id":"alpha"},{"id":"alpha"}]}""",
                    Encoding.UTF8, "application/json")
            });
        }
    }
}
