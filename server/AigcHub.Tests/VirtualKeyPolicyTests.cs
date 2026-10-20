using System.Net;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public class VirtualKeyPolicyTests
{
    [Fact]
    public async Task Creation_sends_selected_models_zero_budget_and_limits_and_returns_only_encrypted_key()
    {
        using var fixture = new Fixture();
        var encrypted = await fixture.Service.CreateAsync("研发组", null, default,
            new(["glm-5.3-flash"], MaxBudget: 0, BudgetDuration: "30d", RpmLimit: 10, TpmLimit: 20000, Duration: "90d"));
        Assert.Equal("sk-generated-test", fixture.Protector.Unprotect(encrypted));
        Assert.DoesNotContain("sk-generated-test", encrypted);
        var payload = fixture.Handler.Writes.Single().Body;
        Assert.Equal("/key/generate", fixture.Handler.Writes.Single().Path);
        Assert.Equal("glm-5.3-flash", payload.GetProperty("models")[0].GetString());
        Assert.Equal(0, payload.GetProperty("max_budget").GetDecimal());
        Assert.Equal("30d", payload.GetProperty("budget_duration").GetString());
        Assert.Equal(10, payload.GetProperty("rpm_limit").GetInt32());
        Assert.Equal(20000, payload.GetProperty("tpm_limit").GetInt32());
        Assert.Equal("90d", payload.GetProperty("duration").GetString());
    }

    [Fact]
    public async Task Readback_is_sanitized_and_urls_contain_only_a_hash()
    {
        using var fixture = new Fixture();
        var current = await fixture.Service.GetPolicyAsync(fixture.Key, default);
        Assert.Equal(50, current.MaxBudget);
        Assert.Equal(10, current.RpmLimit);
        Assert.NotNull(current.Expires);
        Assert.DoesNotContain("sk-existing-test", fixture.Handler.Uris.Single());
        Assert.Equal(64, new Uri(fixture.Handler.Uris.Single()).Query.Split('=')[1].Length);
        var output = JsonSerializer.Serialize(current);
        Assert.DoesNotContain("token", output, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sk-", output);
    }

    [Fact]
    public async Task Updating_only_rpm_preserves_expiry_budget_reset_spend_and_metadata()
    {
        using var fixture = new Fixture();
        await fixture.Service.UpdatePolicyAsync(fixture.Key,
            new(["glm-5.3-flash"], MaxBudget: 50, BudgetDuration: "30d", RpmLimit: 20, TpmLimit: 20000), default);
        var request = fixture.Handler.Writes.Single();
        Assert.Equal("/key/update", request.Path);
        Assert.Equal(2, request.Body.EnumerateObject().Count());
        Assert.Equal(20, request.Body.GetProperty("rpm_limit").GetInt32());
        Assert.False(request.Body.TryGetProperty("duration", out _));
        Assert.False(request.Body.TryGetProperty("budget_duration", out _));
        Assert.False(request.Body.TryGetProperty("spend", out _));
        Assert.False(request.Body.TryGetProperty("metadata", out _));
    }

    [Fact]
    public async Task Clearing_limits_is_explicit_and_unchanged_values_do_not_trigger_an_update()
    {
        using var fixture = new Fixture();
        await fixture.Service.UpdatePolicyAsync(fixture.Key,
            new(["glm-5.3-flash"], MaxBudget: 50, BudgetDuration: "30d", RpmLimit: 10, TpmLimit: 20000), default);
        Assert.Empty(fixture.Handler.Writes);
        await fixture.Service.UpdatePolicyAsync(fixture.Key, new([], AllModels: true, ClearExpiry: true), default);
        var payload = fixture.Handler.Writes.Single().Body;
        Assert.Empty(payload.GetProperty("models").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("max_budget").ValueKind);
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("rpm_limit").ValueKind);
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("tpm_limit").ValueKind);
        Assert.Equal(JsonValueKind.Null, payload.GetProperty("budget_duration").ValueKind);
        Assert.Equal("-1", payload.GetProperty("duration").GetString());
    }

    [Theory]
    [InlineData("", null, null)]
    [InlineData("selected", -1, null)]
    [InlineData("selected", null, "0d")]
    [InlineData("selected", null, "30days")]
    public async Task Invalid_policy_never_reaches_the_gateway(string scope, int? budget, string? duration)
    {
        using var fixture = new Fixture();
        await Assert.ThrowsAsync<WorkflowException>(() => fixture.Service.CreateAsync("test", null, default,
            new(scope == "" ? [] : ["glm-5.3-flash"], MaxBudget: budget, BudgetDuration: duration)));
        Assert.Empty(fixture.Handler.Uris);
    }

    [Fact]
    public async Task Malformed_limits_are_not_displayed_as_unlimited()
    {
        using var fixture = new Fixture();
        fixture.Handler.InfoOverride = "{\"info\":{\"models\":[],\"max_budget\":\"bad-value\"}}";
        var error = await Assert.ThrowsAsync<WorkflowException>(() => fixture.Service.GetPolicyAsync(fixture.Key, default));
        Assert.Equal(502, error.StatusCode);
    }

    [Theory]
    [InlineData("hourly")]
    [InlineData("daily")]
    [InlineData("weekly")]
    [InlineData("monthly")]
    [InlineData("1mo")]
    [InlineData("2w")]
    public void Existing_gateway_duration_formats_are_accepted(string duration)
    {
        LiteLlmVirtualKeyService.ValidatePolicy(new([], AllModels: true, BudgetDuration: duration, Duration: duration));
    }

    [Fact]
    public async Task Unknown_model_and_upstream_write_failure_are_not_reported_as_success()
    {
        using var fixture = new Fixture();
        await Assert.ThrowsAsync<WorkflowException>(() => fixture.Service.CreateAsync("test", null, default, new(["missing"])));
        Assert.Empty(fixture.Handler.Writes);
        fixture.Handler.FailWrites = true;
        var error = await Assert.ThrowsAsync<WorkflowException>(() => fixture.Service.UpdatePolicyAsync(fixture.Key,
            new(["glm-5.3-flash"], MaxBudget: 1), default));
        Assert.Equal(502, error.StatusCode);
        Assert.DoesNotContain("sk-", error.Message);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly AigcHubDbContext db = new(new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
        public readonly Gateway Handler = new();
        public readonly IDataProtector Protector;
        public readonly LiteLlmVirtualKeyService Service;
        public readonly string Key;
        public Fixture()
        {
            var protection = new EphemeralDataProtectionProvider();
            Protector = protection.CreateProtector("AigcHub.ManagedVirtualKey.v1");
            Key = Protector.Protect("sk-existing-test");
            Service = new(new ClientFactory(Handler), Options.Create(new LiteLlmOptions { BaseUrl = "https://proxy.test/v1", ManagementApiKey = "management-test" }),
                db, protection, NullLogger<LiteLlmVirtualKeyService>.Instance);
        }
        public void Dispose() => db.Dispose();
    }
    private sealed class ClientFactory(Gateway handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
    private sealed class Gateway : HttpMessageHandler
    {
        public readonly List<string> Uris = [];
        public readonly List<(string Path, JsonElement Body)> Writes = [];
        public bool FailWrites;
        public string? InfoOverride;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal("Bearer management-test", request.Headers.Authorization!.ToString());
            Uris.Add(request.RequestUri!.ToString());
            if (request.Method == HttpMethod.Post)
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
                Writes.Add((request.RequestUri.AbsolutePath, body.RootElement.Clone()));
                return new(FailWrites ? HttpStatusCode.BadRequest : HttpStatusCode.OK) { Content = new StringContent("{\"key\":\"sk-generated-test\"}") };
            }
            var json = request.RequestUri.AbsolutePath == "/v1/models"
                ? "{\"data\":[{\"id\":\"glm-5.3-flash\"},{\"id\":\"deepseek-flash\"}]}"
                : InfoOverride ?? "{\"info\":{\"models\":[\"glm-5.3-flash\"],\"max_budget\":50,\"budget_duration\":\"30d\",\"rpm_limit\":10,\"tpm_limit\":20000,\"expires\":\"2030-01-01T00:00:00Z\",\"token\":\"secret-hash\"}}";
            return new(HttpStatusCode.OK) { Content = new StringContent(json) };
        }
    }
}
