using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using AigcHub.Api.Configuration;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AigcHub.Tests;

public sealed class GiteaTlsTests
{
    [Fact]
    public async Task Only_explicitly_disabled_connection_accepts_untrusted_certificate_and_redirects_stay_disabled()
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", key, System.Security.Cryptography.HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var generated = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        using var certificate = X509CertificateLoader.LoadPkcs12(generated.Export(X509ContentType.Pfx), null);
        var host = WebApplication.CreateBuilder();
        host.Logging.ClearProviders();
        host.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0, listen => listen.UseHttps(certificate)));
        await using var server = host.Build();
        server.MapGet("/", () => "TLS probe");
        server.MapGet("/redirect", () => Microsoft.AspNetCore.Http.Results.Redirect("/"));
        await server.StartAsync();
        var address = server.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();

        var builder = WebApplication.CreateBuilder();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> {
            ["ConnectionStrings:PostgreSql"] = "Host=localhost;Database=unused",
            ["Jwt:Key"] = new string('t', 64)
        });
        builder.AddAigcHubServices();
        using var services = builder.Services.BuildServiceProvider();
        var clients = services.GetRequiredService<IHttpClientFactory>();
        var settings = new ConfigurationBuilder().AddInMemoryCollection().Build();
        using var strict = clients.CreateClient(GiteaService.ClientName(settings));
        await Assert.ThrowsAsync<HttpRequestException>(() => strict.GetAsync(address));
        settings["VerifySsl"] = "false";
        using var bypass = clients.CreateClient(GiteaService.ClientName(settings));
        Assert.Equal("TLS probe", await bypass.GetStringAsync(address));
        using var redirect = await bypass.GetAsync(address + "/redirect");
        Assert.Equal(HttpStatusCode.Redirect, redirect.StatusCode);
        // The strict client remains strict even after the bypass client is used.
        await Assert.ThrowsAsync<HttpRequestException>(() => strict.GetAsync(address));
    }
}
