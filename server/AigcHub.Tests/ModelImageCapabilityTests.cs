using System.Net;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public class ModelImageCapabilityTests
{
    [Theory]
    [InlineData("Auto", null, "unknown", "undisclosed")]
    [InlineData("Auto", true, "supported", "upstream")]
    [InlineData("Auto", false, "unsupported", "upstream")]
    [InlineData("Supported", false, "supported", "administrator")]
    [InlineData("Unsupported", true, "unsupported", "administrator")]
    public void Explicit_configuration_overrides_metadata_and_unknown_is_preserved(
        string mode, bool? upstream, string state, string source)
    {
        var result = ModelImageCapability.Resolve(mode, new(upstream, null, null, "chat", []));
        Assert.Equal(state, result.State);
        Assert.Equal(source, result.Source);
        Assert.Equal(state == "supported", result.Input.Contains("image"));
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    [InlineData("null", null)]
    [InlineData("\"true\"", null)]
    [InlineData(null, null)]
    public async Task Capability_lookup_distinguishes_false_from_missing_or_invalid(string? flag, bool? expected)
    {
        await using var db = Database();
        var field = flag is null ? "" : $"\"supports_vision\":{flag}";
        var service = new LiteLlmVirtualKeyService(new ClientFactory(
            $"{{\"data\":[{{\"model_name\":\"custom-alias\",\"model_info\":{{{field}}}}}]}}"),
            Options.Create(new LiteLlmOptions { BaseUrl = "https://proxy.test/v1", ManagementApiKey = "test-management" }),
            db, new EphemeralDataProtectionProvider(), NullLogger<LiteLlmVirtualKeyService>.Instance);
        var result = await service.CapabilitiesAsync(default);
        Assert.Equal(expected, result["custom-alias"].SupportsVision);
        Assert.False(result.ContainsKey("Custom-Alias"));
    }

    [Fact]
    public async Task Failed_metadata_lookup_reports_unknown_instead_of_unsupported()
    {
        await using var db = Database();
        var service = new LiteLlmVirtualKeyService(new ClientFactory("{}", HttpStatusCode.ServiceUnavailable),
            Options.Create(new LiteLlmOptions { BaseUrl = "https://proxy.test/v1", ManagementApiKey = "test-management" }),
            db, new EphemeralDataProtectionProvider(), NullLogger<LiteLlmVirtualKeyService>.Instance);
        var result = await service.CapabilitiesAsync(default);
        Assert.Empty(result);
        Assert.Equal("unknown", ModelImageCapability.Resolve("Auto").State);
    }

    [Theory]
    [InlineData("true", "false", null)]
    [InlineData("false", "true", null)]
    [InlineData("null", "true", null)]
    [InlineData("true", "true", true)]
    [InlineData("false", "false", false)]
    public async Task Multiple_deployments_under_one_alias_must_agree(string first, string second, bool? expected)
    {
        await using var db = Database();
        var payload = $"{{\"data\":[{{\"model_name\":\"alias\",\"model_info\":{{\"supports_vision\":{first}}}}},{{\"model_name\":\"alias\",\"model_info\":{{\"supports_vision\":{second}}}}}]}}";
        var service = new LiteLlmVirtualKeyService(new ClientFactory(payload),
            Options.Create(new LiteLlmOptions { BaseUrl = "https://proxy.test/v1", ManagementApiKey = "test-management" }),
            db, new EphemeralDataProtectionProvider(), NullLogger<LiteLlmVirtualKeyService>.Instance);
        Assert.Equal(expected, (await service.CapabilitiesAsync(default))["alias"].SupportsVision);
    }

    [Fact]
    public async Task Old_admin_requests_preserve_override_and_invalid_modes_are_rejected()
    {
        await using var db = Database();
        var service = new ModelConfigurationService(db, new EphemeralDataProtectionProvider(), Options.Create(new ChatOptions()));
        var request = new SaveModelConfigurationRequest("Vision", "Local", "http://gpu.test/v1", "/chat/completions",
            "custom-name", null, "None", "X-API-Key", true, true, false, 0.3, null, 0, "Supported", "0.5×");
        var model = await service.SaveAsync(null, request, default);
        Assert.Equal("Supported", model.ImageInputMode);
        await service.SaveAsync(model.Id, request with { Name = "Renamed", ImageInputMode = null, Multiplier = null }, default);
        Assert.Equal("Supported", model.ImageInputMode);
        Assert.Equal("0.5×", model.Multiplier);
        Assert.Equal("0.5×", (await service.ResolveAsync(model.Id, default))!.Multiplier);
        await Assert.ThrowsAsync<WorkflowException>(() => service.SaveAsync(model.Id, request with { Multiplier = new string('x', 33) }, default));
        await service.SaveAsync(model.Id, request with { ImageInputMode = "Auto" }, default);
        Assert.Equal("Auto", model.ImageInputMode);
        await Assert.ThrowsAsync<WorkflowException>(() => service.SaveAsync(model.Id,
            request with { ImageInputMode = "typo" }, default));
    }

    private static AigcHubDbContext Database() => new(new DbContextOptionsBuilder<AigcHubDbContext>()
        .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);

    private sealed class ClientFactory(string payload, HttpStatusCode status = HttpStatusCode.OK) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(payload, status));
    }
    private sealed class Handler(string payload, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("https://proxy.test/model/info", request.RequestUri!.ToString());
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(payload) });
        }
    }
}
