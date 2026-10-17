using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class PluginMarketHttpTests
{
    [Fact]
    public async Task ReportsPaginateBeyondFiveHundredWithStableOrderingAndBoundedPageSize()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, false);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var userId = await db.Users.Select(x => x.Id).FirstAsync();
        var pluginId = Guid.NewGuid();
        var timestamp = DateTimeOffset.UtcNow;
        db.ManagedPluginReports.AddRange(Enumerable.Range(0, 505).Select(index => new AigcHub.Api.Domain.ManagedPluginReport
        {
            UserId = userId, PluginId = pluginId, DeviceId = $"device-{index:D4}", UpdatedAt = timestamp, Status = "Active"
        }));
        await db.SaveChangesAsync();
        var first = await admin.GetFromJsonAsync<JsonElement>("/api/plugins/reports?page=1&pageSize=20");
        var last = await admin.GetFromJsonAsync<JsonElement>("/api/plugins/reports?page=26&pageSize=20");
        Assert.Equal(505, first.GetProperty("total").GetInt32());
        Assert.Equal(20, first.GetProperty("items").GetArrayLength());
        Assert.Equal("device-0000", first.GetProperty("items")[0].GetProperty("deviceId").GetString());
        Assert.Equal(5, last.GetProperty("items").GetArrayLength());
        Assert.Equal("device-0500", last.GetProperty("items")[0].GetProperty("deviceId").GetString());
        var bounded = await admin.GetFromJsonAsync<JsonElement>("/api/plugins/reports?page=999&pageSize=1000");
        Assert.Equal(100, bounded.GetProperty("pageSize").GetInt32());
        Assert.Equal(6, bounded.GetProperty("page").GetInt32());
    }

    [Fact]
    public async Task SearchUsesConfiguredProxyWithoutChangingAuthorizationPolicy()
    {
        using var factory = new Factory("https://litellm.boschhuayu-steering.com/__aigc/bocha-search");
        await VerifySearchPolicy(factory);
    }

    [Fact]
    public async Task UploadPublishDownloadSearchAndRevokeUseOneAuthoritativePolicy()
    {
        using var factory = new Factory();
        await VerifySearchPolicy(factory);
    }

    private static async Task VerifySearchPolicy(Factory factory)
    {
        using var admin = await Login(factory, false);
        using var desktop = await Login(factory, true);
        var grantOptions = await admin.GetFromJsonAsync<JsonElement>("/api/plugins/grant-options");
        Assert.All(grantOptions.GetProperty("users").EnumerateArray(), user => Assert.True(user.TryGetProperty("employeeNo", out _)));
        Assert.All(grantOptions.GetProperty("roles").EnumerateArray(), role => Assert.True(role.TryGetProperty("code", out _)));
        Assert.All(grantOptions.GetProperty("departments").EnumerateArray(), department => Assert.True(department.TryGetProperty("code", out _)));
        using var upload = new MultipartFormDataContent();
        var bytes = await File.ReadAllBytesAsync(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../plugins/dsh-plugin-managed-search/bhss-dsh-plugin-managed-search-1.0.0.tgz")));
        upload.Add(new ByteArrayContent(bytes), "package", "search.tgz");
        var response = await admin.PostAsync("/api/plugins/upload", upload); Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("pluginId").GetGuid(); var version = created.GetProperty("versionId").GetGuid();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var userId = await db.Users.Where(x => x.EmployeeNo == "wh00028").Select(x => x.Id).SingleAsync();
        var policy = new { name = "博查网页搜索", isEnabled = true, versionId = version, configuration = new { },
            grants = new { userIds = new[] { userId }, roleIds = Array.Empty<Guid>(), departmentIds = Array.Empty<Guid>() }, serverSecret = "test-bocha-secret" };
        (await admin.PutAsJsonAsync($"/api/plugins/{id}/policy", policy)).EnsureSuccessStatusCode();
        var feed = await desktop.GetFromJsonAsync<JsonElement>("/v1/plugins/policy");
        Assert.DoesNotContain("test-bocha-secret", feed.GetRawText());
        var plugin = feed.GetProperty("plugins")[0]; Assert.True(plugin.GetProperty("enabled").GetBoolean());
        var path = plugin.GetProperty("downloadPath").GetString()!;
        Assert.Equal(bytes, await desktop.GetByteArrayAsync(path));
        var search = await desktop.PostAsJsonAsync("/v1/plugins/search", new { query = "中文查询", maxResults = 1 }); search.EnsureSuccessStatusCode();
        var result = await search.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("长摘要", result.GetProperty("sources")[0].GetProperty("snippet").GetString());
        Assert.Equal(1, factory.UpstreamCalls);
        (await desktop.PostAsJsonAsync("/v1/plugins/reports", new { deviceId = "test-device", pluginId = id, version = "1.0.0", revision = 2, status = "Active" })).EnsureSuccessStatusCode();
        var reports = await admin.GetFromJsonAsync<JsonElement>("/api/plugins/reports?page=1&pageSize=1");
        Assert.Single(reports.GetProperty("items").EnumerateArray());
        Assert.Equal(1, reports.GetProperty("total").GetInt32());
        Assert.Equal(1, reports.GetProperty("pageSize").GetInt32());
        (await admin.PutAsJsonAsync($"/api/plugins/{id}/policy", policy with { isEnabled = false, serverSecret = "" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await desktop.GetAsync(path)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await desktop.PostAsJsonAsync("/v1/plugins/search", new { query = "x" })).StatusCode);
        Assert.Equal(1, factory.UpstreamCalls);
        feed = await desktop.GetFromJsonAsync<JsonElement>("/v1/plugins/policy");
        Assert.False(feed.GetProperty("plugins")[0].GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task DuplicateVersionsAndAnonymousManagementAreRejected()
    {
        using var factory = new Factory(); using var admin = await Login(factory, false); using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/plugins")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/v1/plugins/policy")).StatusCode);
        for (var i = 0; i < 2; i++)
        {
            using var content = new MultipartFormDataContent(); content.Add(new ByteArrayContent(Package()), "package", "search.tgz");
            Assert.Equal(i == 0 ? HttpStatusCode.OK : HttpStatusCode.Conflict, (await admin.PostAsync("/api/plugins/upload", content)).StatusCode);
        }
    }

    [Fact]
    public void PackageReaderRejectsInstallScriptsAndMapsValidSources()
    {
        Assert.Equal("1.0.0", AigcHub.Api.Services.PluginPackageReader.Read(new MemoryStream(Package())).Version);
        Assert.ThrowsAny<Exception>(() => AigcHub.Api.Services.PluginPackageReader.Read(new MemoryStream(Package(true))));
        using var json = JsonDocument.Parse("""{"code":200,"data":{"webPages":{"value":[{"url":"https://example.com","snippet":"short"},{"url":"https://example.com"},{"url":"javascript:bad"}]}}}""");
        var mapped = AigcHub.Api.Services.BochaSearchService.Map(json.RootElement, 8);
        Assert.Equal(mapped.Sources, AigcHub.Api.Services.BochaSearchService.Map(json.RootElement.GetProperty("data"), 8).Sources);
        Assert.Single(mapped.Sources); Assert.Equal("short", mapped.Sources[0].Snippet);
        foreach (var invalid in new[] { "null", "[]", "{\"code\":\"200\"}", "{\"code\":200,\"data\":null}" })
        {
            using var invalidJson = JsonDocument.Parse(invalid);
            Assert.Throws<InvalidDataException>(() => AigcHub.Api.Services.BochaSearchService.Map(invalidJson.RootElement, 8));
        }
    }

    private static byte[] Package(bool scripts = false)
    {
        using var stream = new MemoryStream();
        using (var gzip = new GZipStream(stream, CompressionLevel.Fastest, true))
        using (var tar = new TarWriter(gzip, leaveOpen: true))
        {
            var manifest = JsonSerializer.Serialize(new { name = "@bhss/dsh-plugin-managed-search", version = "1.0.0", description = "search", main = "lib/index.js",
                scripts = scripts ? new Dictionary<string, string> { ["install"] = "bad" } : new(),
                dsh = new { bundle = new { patch = "./cordis.patch.yml" } }, aigc = new { dshVersion = "0.1.7-alpha.2" } });
            foreach (var (name, text) in new[] { ("package/package.json", manifest), ("package/cordis.patch.yml", "[]"), ("package/lib/index.js", "export function apply() {}") })
                tar.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(text)) });
        }
        return stream.ToArray();
    }

    private static async Task<HttpClient> Login(Factory factory, bool desktop)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync(desktop ? "/v1/auth/login" : "/api/auth/login",
            desktop ? new { username = "wh00028", password = "Bhss@123" } : (object)new { employeeNo = "wh00028", password = "Bhss@123" });
        response.EnsureSuccessStatusCode(); var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", result.GetProperty(desktop ? "access_token" : "accessToken").GetString());
        return client;
    }

    private sealed class Factory(string endpoint = "https://api.bochaai.com/v1/web-search") : WebApplicationFactory<Program>
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "plugin-market-" + Guid.NewGuid().ToString("N"));
        public int UpstreamCalls;
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("BochaSearch:Endpoint", endpoint);
            builder.UseSetting("Plugins:StoragePath", root); builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.ConfigureServices(services => {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(root));
                services.AddHttpClient("bocha-web-search").ConfigurePrimaryHttpMessageHandler(() => new Upstream(this));
            });
        }
        private sealed class Upstream(Factory owner) : HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.UpstreamCalls++;
                Assert.Equal(owner.Endpoint, request.RequestUri!.AbsoluteUri);
                Assert.Equal("test-bocha-secret", request.Headers.Authorization?.Parameter);
                var body = await request.Content!.ReadFromJsonAsync<JsonElement>(ct);
                Assert.Equal(1, body.GetProperty("count").GetInt32());
                return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { code = 200, data = new { webPages = new { value = new[] { new { url = "https://example.com", name = "示例", summary = "长摘要" } } } } }) };
            }
        }
        private string Endpoint => endpoint;
        protected override void Dispose(bool disposing) { base.Dispose(disposing); if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
