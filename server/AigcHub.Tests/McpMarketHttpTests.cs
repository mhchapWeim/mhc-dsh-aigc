using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using AigcHub.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.Tokens;

namespace AigcHub.Tests;

public sealed class McpMarketHttpTests
{
    [Fact]
    public async Task AuthorizationIconsDiscoveryCallsAndRevocationShareOnePolicy()
    {
        using var factory=new Factory(); using var admin=await Login(factory,false); using var desktop=await Login(factory,true);
        using var anonymous=factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized,(await anonymous.GetAsync("/api/mcp")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,(await anonymous.GetAsync("/v1/mcp/policy")).StatusCode);
        using var scope=factory.Services.CreateScope(); var db=scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var userId=await db.Users.Where(x=>x.EmployeeNo=="wh00028").Select(x=>x.Id).SingleAsync();
        var policy=new {name="生产追溯",description="查询产品履历",url="https://mcp.test/mcp",isEnabled=true,timeoutSeconds=30,
            grants=new {userIds=Array.Empty<Guid>(),roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret="upstream-only"};
        var created=await admin.PostAsJsonAsync("/api/mcp",policy); created.EnsureSuccessStatusCode();
        var id=(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var feed=await desktop.GetFromJsonAsync<JsonElement>("/v1/mcp/policy"); Assert.Empty(feed.GetProperty("services").EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden,(await desktop.PostAsJsonAsync($"/v1/mcp/{id}/gateway",new {})).StatusCode);
        var authorized=policy with {grants=new {userIds=new[]{userId},roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()}};
        (await admin.PutAsJsonAsync($"/api/mcp/{id}",authorized)).EnsureSuccessStatusCode();
        using var icon=new MultipartFormDataContent(); icon.Add(new ByteArrayContent(Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4WQAAAAASUVORK5CYII=")),"icon","icon.png");
        (await admin.PostAsync($"/api/mcp/{id}/icon",icon)).EnsureSuccessStatusCode();
        feed=await desktop.GetFromJsonAsync<JsonElement>("/v1/mcp/policy"); var service=Assert.Single(feed.GetProperty("services").EnumerateArray());
        Assert.StartsWith("data:image/png;base64,",service.GetProperty("iconDataUrl").GetString());
        Assert.False(service.TryGetProperty("url",out _)); Assert.DoesNotContain("upstream-only",feed.GetRawText());
        (await admin.PostAsJsonAsync($"/api/mcp/{id}/test",new {})).EnsureSuccessStatusCode();
        var call=await desktop.PostAsJsonAsync($"/v1/mcp/{id}/gateway",new {jsonrpc="2.0",id=2,method="tools/call",@params=new {name="trace",arguments=new {sn="SN001"}}});
        call.EnsureSuccessStatusCode(); Assert.Contains("SN001",await call.Content.ReadAsStringAsync()); Assert.Equal(2,factory.Calls);
        (await admin.PutAsJsonAsync($"/api/mcp/{id}",policy)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden,(await desktop.PostAsJsonAsync($"/v1/mcp/{id}/gateway",new {})).StatusCode);
        feed=await desktop.GetFromJsonAsync<JsonElement>("/v1/mcp/policy"); Assert.Empty(feed.GetProperty("services").EnumerateArray()); Assert.Equal(2,factory.Calls);
        using var bad=new MultipartFormDataContent(); bad.Add(new StringContent("<svg>bad</svg>"),"icon","icon.png");
        Assert.Equal(HttpStatusCode.BadRequest,(await admin.PostAsync($"/api/mcp/{id}/icon",bad)).StatusCode);
    }

    [Fact]
    public async Task OrdinaryUserCannotManageAndCredentialsNeverAppearInAdminCatalog()
    {
        using var factory=new Factory(); using var admin=await Login(factory,false); using var ordinary=factory.CreateClient();
        var login=await ordinary.PostAsJsonAsync("/api/auth/login",new {employeeNo="wh00412",password="Bhss@123"});login.EnsureSuccessStatusCode();
        ordinary.DefaultRequestHeaders.Authorization=new("Bearer",(await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        Assert.Equal(HttpStatusCode.Forbidden,(await ordinary.GetAsync("/api/mcp")).StatusCode);
        var response=await admin.PostAsJsonAsync("/api/mcp",new {name="test",description="",url="file:///tmp/mcp",isEnabled=true,timeoutSeconds=60,grants=new {userIds=Array.Empty<Guid>(),roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()}});
        Assert.Equal(HttpStatusCode.BadRequest,response.StatusCode);
    }


    [Fact]
    public async Task SessionHandlesAreBoundToUserServiceAndRevision()
    {
        using var factory=new Factory {Sessions=true};using var admin=await Login(factory,false);using var first=await Login(factory,true);
        using var other=factory.CreateClient();var login=await other.PostAsJsonAsync("/v1/auth/login",new {username="wh00412",password="Bhss@123"});login.EnsureSuccessStatusCode();
        other.DefaultRequestHeaders.Authorization=new("Bearer",(await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("access_token").GetString());
        using var scope=factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var userIds=await db.Users.Where(x=>x.EmployeeNo=="wh00028"||x.EmployeeNo=="wh00412").Select(x=>x.Id).ToArrayAsync();
        var policy=new {name="session",description="",url="https://mcp.test/mcp",isEnabled=true,timeoutSeconds=30,
            grants=new {userIds,roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret="upstream-only"};
        var created=await admin.PostAsJsonAsync("/api/mcp",policy);created.EnsureSuccessStatusCode();var id=(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var path=$"/v1/mcp/{id}/gateway";
        var opened=await first.PostAsJsonAsync(path,new {method="tools/call"});opened.EnsureSuccessStatusCode();
        var handle=opened.Headers.GetValues("Mcp-Session-Id").Single();Assert.NotEqual("upstream-session",handle);
        first.DefaultRequestHeaders.Add("Mcp-Session-Id",handle);
        (await first.PostAsJsonAsync(path,new {method="tools/call"})).EnsureSuccessStatusCode();Assert.Equal("upstream-session",factory.LastSession);
        other.DefaultRequestHeaders.Add("Mcp-Session-Id",handle);
        Assert.Equal(HttpStatusCode.NotFound,(await other.PostAsJsonAsync(path,new {method="tools/call"})).StatusCode);
        (await admin.PutAsJsonAsync($"/api/mcp/{id}",policy)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound,(await first.PostAsJsonAsync(path,new {method="tools/call"})).StatusCode);
        Assert.Equal(2,factory.Calls);
    }

    [Fact]
    public async Task DiscoveryAcceptsSseFramesWithoutExecutingTools()
    {
        using var factory=new Factory {Sse=true};using var admin=await Login(factory,false);
        var created=await admin.PostAsJsonAsync("/api/mcp",new {name="SSE",description="",url="https://mcp.test/mcp",isEnabled=false,timeoutSeconds=5,
            grants=new {userIds=Array.Empty<Guid>(),roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret="upstream-only"});
        created.EnsureSuccessStatusCode();var id=(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var tested=await admin.PostAsJsonAsync($"/api/mcp/{id}/test",new {});tested.EnsureSuccessStatusCode();
        Assert.Equal("trace",(await tested.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("tools")[0].GetProperty("name").GetString());Assert.Equal(1,factory.Calls);
    }

    [Fact]
    public async Task PlainHttpMcpAddressIsRejectedForUserAssertionExchange()
    {
        using var factory=new Factory();using var admin=await Login(factory,false);
        var response=await admin.PostAsJsonAsync("/api/mcp",new {name="Insecure",description="",url="http://192.168.1.10:8080/mcp",isEnabled=true,timeoutSeconds=30,
            authenticationMode="UserAssertionExchange",tokenExchangeUrl="https://knowengine.test/oauth2/dsh-token",assertionAudience="knowengine-mcp",
            tokenResource="https://knowengine.test/mcp",tokenScopes="kb:read",
            grants=new {userIds=Array.Empty<Guid>(),roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret=""});
        Assert.Equal(HttpStatusCode.BadRequest,response.StatusCode);
        var loopback=await admin.PostAsJsonAsync("/api/mcp",new {name="Local",description="",url="http://localhost:8765/mcp",isEnabled=true,timeoutSeconds=30,
            authenticationMode="UserAssertionExchange",tokenExchangeUrl="https://knowengine.test/oauth2/dsh-token",assertionAudience="knowengine-mcp",
            tokenResource="https://localhost:8765/mcp",tokenScopes="kb:read",
            grants=new {userIds=Array.Empty<Guid>(),roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret=""});
        loopback.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task AuthorizedUserReceivesShortAudienceBoundAssertionForExchangeService()
    {
        using var factory=new Factory();using var admin=await Login(factory,false);using var desktop=await Login(factory,true);
        using var scope=factory.Services.CreateScope();var db=scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var userId=await db.Users.Where(x=>x.EmployeeNo=="wh00028").Select(x=>x.Id).SingleAsync();
        var created=await admin.PostAsJsonAsync("/api/mcp",new {name="KnowEngine",description="",url="https://knowengine.test/mcp",isEnabled=true,timeoutSeconds=30,
            authenticationMode="UserAssertionExchange",tokenExchangeUrl="https://knowengine.test/oauth2/dsh-token",assertionAudience="knowengine-mcp",
            tokenResource="https://knowengine.test/mcp",tokenScopes="kb:read knowledge:ask",
            grants=new {userIds=new[]{userId},roleIds=Array.Empty<Guid>(),departmentIds=Array.Empty<Guid>()},serverSecret=""});
        created.EnsureSuccessStatusCode();var id=(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var policy=await desktop.GetFromJsonAsync<JsonElement>("/v1/mcp/policy");var service=Assert.Single(policy.GetProperty("services").EnumerateArray());
        Assert.Equal("user-assertion-exchange",service.GetProperty("authenticationMode").GetString());
        var response=await desktop.PostAsync($"/v1/mcp/{id}/identity-assertion",null);response.EnsureSuccessStatusCode();
        var assertion=(await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("assertion").GetString()!;
        var handler=new JwtSecurityTokenHandler {MapInboundClaims=false};
        var principal=handler.ValidateToken(assertion,new TokenValidationParameters {ValidateIssuer=true,ValidIssuer="bhss-aigc",
            ValidateAudience=true,ValidAudience="knowengine-mcp",ValidateLifetime=true,ValidateIssuerSigningKey=true,
            IssuerSigningKey=new RsaSecurityKey(factory.PublicKey),ClockSkew=TimeSpan.Zero},out _);
        Assert.Equal("wh00028",principal.FindFirst(JwtRegisteredClaimNames.Sub)?.Value);
        Assert.NotNull(principal.FindFirst(JwtRegisteredClaimNames.Jti));
        var payload=new JwtSecurityTokenHandler().ReadJwtToken(assertion).Payload;
        Assert.True(payload.ContainsKey("iat"), "assertion must carry iat; KnowEngine validates it");
        var iat=Assert.IsType<long>(payload["iat"]);
        Assert.InRange(iat,(long)(payload["nbf"] as long? ?? 0),(long)(payload["exp"] as long? ?? long.MaxValue));
    }

    private static async Task<HttpClient> Login(Factory factory,bool desktop)
    {
        var client=factory.CreateClient();var response=await client.PostAsJsonAsync(desktop?"/v1/auth/login":"/api/auth/login",
            desktop?(object)new {username="wh00028",password="Bhss@123"}:new {employeeNo="wh00028",password="Bhss@123"});response.EnsureSuccessStatusCode();
        client.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",(await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty(desktop?"access_token":"accessToken").GetString());return client;
    }
    private sealed class Factory:WebApplicationFactory<Program>
    {
        private readonly string root=Path.Combine(Path.GetTempPath(),"mcp-market-"+Guid.NewGuid().ToString("N"));
        private readonly RSA signingKey=RSA.Create(2048);public RSAParameters PublicKey=>signingKey.ExportParameters(false);
        public int Calls; public bool Sessions; public bool Sse; public string? LastSession;
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("DataProtection:KeysPath",Path.Combine(root,"keys"));
            builder.UseSetting("McpIdentityAssertion:Issuer","bhss-aigc");builder.UseSetting("McpIdentityAssertion:KeyId","test-key");
            builder.UseSetting("McpIdentityAssertion:PrivateKeyPem",signingKey.ExportRSAPrivateKeyPem());
            builder.ConfigureServices(services=>{services.RemoveAll<DbContextOptions<AigcHubDbContext>>();services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options=>options.UseInMemoryDatabase(root));
                services.AddHttpClient("mcp-gateway").ConfigurePrimaryHttpMessageHandler(()=>new Upstream(this));});
        }
        private sealed class Upstream(Factory owner):HttpMessageHandler
        {
            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
            {
                owner.Calls++; Assert.Equal("https://mcp.test/mcp",request.RequestUri!.AbsoluteUri);Assert.Equal("upstream-only",request.Headers.Authorization?.Parameter);
                var body=await request.Content!.ReadFromJsonAsync<JsonElement>(ct);
                owner.LastSession=request.Headers.TryGetValues("Mcp-Session-Id",out var sessions)?sessions.Single():null;
                if(owner.Sse)return new(HttpStatusCode.OK){Content=new StringContent("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"trace\"}]}}\n\n",System.Text.Encoding.UTF8,"text/event-stream")};
                var response=new HttpResponseMessage(HttpStatusCode.OK){Content=body.GetProperty("method").GetString()=="tools/list"
                    ? JsonContent.Create(new {jsonrpc="2.0",id=1,result=new {tools=new[]{new {name="trace",description="Query trace",inputSchema=new {type="object"}}}}})
                    : JsonContent.Create(new {jsonrpc="2.0",id=2,result=new {content=new[]{new {type="text",text="SN001 OK"}}}})};
                if(owner.Sessions)response.Headers.Add("Mcp-Session-Id","upstream-session");return response;
            }
        }
        protected override void Dispose(bool disposing){base.Dispose(disposing);signingKey.Dispose();if(Directory.Exists(root))Directory.Delete(root,true);}
    }
}
