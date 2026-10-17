using System.Net.Security;
using AigcHub.Api.Configuration;
using AigcHub.Api.Services;
using Microsoft.Extensions.Configuration;

namespace AigcHub.Tests;

public sealed class LiteLlmSslConfigurationTests
{
    [Fact]
    public void CertificateVerificationIsEnabledByDefault()
    {
        var options = new LiteLlmOptions();
        Assert.True(options.VerifySsl);

        using var sync = ApplicationConfiguration.CreateLiteLlmHttpHandler(options.VerifySsl, false);
        using var management = ApplicationConfiguration.CreateLiteLlmHttpHandler(options.VerifySsl, false);
        Assert.Null(sync.ServerCertificateCustomValidationCallback);
        Assert.Null(management.ServerCertificateCustomValidationCallback);
        Assert.False(sync.AllowAutoRedirect);
        Assert.False(management.AllowAutoRedirect);
    }

    [Fact]
    public void ExplicitFalseDisablesCertificateVerificationForBothLiteLlmClients()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LiteLlm:VerifySsl"] = "false"
        }).Build();
        var options = configuration.GetSection("LiteLlm").Get<LiteLlmOptions>();
        Assert.NotNull(options);
        Assert.False(options.VerifySsl);

        using var sync = ApplicationConfiguration.CreateLiteLlmHttpHandler(options.VerifySsl, false);
        using var management = ApplicationConfiguration.CreateLiteLlmHttpHandler(options.VerifySsl, false);
        using var request = new HttpRequestMessage();
        Assert.True(sync.ServerCertificateCustomValidationCallback!(request, null, null,
            SslPolicyErrors.RemoteCertificateChainErrors));
        Assert.True(management.ServerCertificateCustomValidationCallback!(request, null, null,
            SslPolicyErrors.RemoteCertificateChainErrors));
    }
}
