using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace AigcHub.Tests;

public sealed class ApplicationGatewayHttpTests
{
    [Fact]
    public async Task Publication_submit_uses_the_binding_and_keeps_inflight_versions()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var admin = await Login(factory, "wh00028");
        var categoryId = await FirstCategory(applicant);
        var submitted = await applicant.PostAsJsonAsync("/api/publication-requests", new { appName = "绑定应用", categoryId, summary = "说明", processKey = "not-a-real-process", accessMode = "All" });
        Assert.Equal(HttpStatusCode.OK, submitted.StatusCode);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var request = await db.PublicationRequests.SingleAsync(x => x.AppName == "绑定应用");
        var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == request.ProcessInstanceId);
        var bound = await db.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId);
        Assert.Equal("application-publishing", bound.Key);

        var created = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key = "application-publishing", name = "应用发布审批流程", version = 3, isPublished = false, requestType = "publication",
            definition = JsonDocument.Parse("""{"nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"审核","candidates":["role:workflow-admin"]},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end"}]}""").RootElement
        });
        created.EnsureSuccessStatusCode();
        var draftId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.NoContent, (await admin.PostAsync($"/api/process-definitions/{draftId}/publish", null)).StatusCode);
        Assert.Equal(bound.Id, (await db.WorkflowInstances.SingleAsync(x => x.Id == instance.Id)).ProcessDefinitionId);

        var again = await applicant.PostAsJsonAsync("/api/publication-requests", new { appName = "新版本申请", categoryId, summary = "说明", accessMode = "All" });
        again.EnsureSuccessStatusCode();
        var second = await db.PublicationRequests.SingleAsync(x => x.AppName == "新版本申请");
        var secondInstance = await db.WorkflowInstances.SingleAsync(x => x.Id == second.ProcessInstanceId);
        Assert.Equal(draftId, secondInstance.ProcessDefinitionId);
        Assert.NotEqual(instance.ProcessDefinitionId, secondInstance.ProcessDefinitionId);
    }

    [Fact]
    public async Task Missing_binding_rejects_submission_without_a_row()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        db.RequestProcessBindings.RemoveRange(db.RequestProcessBindings);
        await db.SaveChangesAsync();
        var before = await db.PublicationRequests.CountAsync();
        var categoryId = await FirstCategory(applicant);
        var response = await applicant.PostAsJsonAsync("/api/publication-requests", new { appName = "不会创建", categoryId, summary = "说明", accessMode = "All" });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("未创建申请", await response.Content.ReadAsStringAsync());
        Assert.Equal(before, await db.PublicationRequests.CountAsync());
    }

    [Fact]
    public async Task Access_approval_grants_once_and_rejects_duplicates_and_dead_apps()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var reviewer = await Login(factory, "wh00136");
        using var outsider = await Login(factory, "wh00028");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        await PublishAccessProcess(outsider);
        var category = await db.Categories.FirstAsync();
        var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var app = new PublicationRequest { RequestNo = "PUB-ACC-1", AppName = "受限设备", Summary = "说明", CategoryId = category.Id, ApplicantId = user.Id, Status = PublicationStatus.Approved, AccessMode = "Subjects" };
        var dead = new PublicationRequest { RequestNo = "PUB-ACC-2", AppName = "即将下架", Summary = "说明", CategoryId = category.Id, ApplicantId = user.Id, Status = PublicationStatus.Approved, AccessMode = "Subjects" };
        db.PublicationRequests.AddRange(app, dead);
        db.ApplicationRoutes.AddRange(
            new ApplicationRoute { PublicationRequestId = app.Id, Slug = "limited-device", UpstreamUrl = "https://origin.example/device/", Status = "Ready" },
            new ApplicationRoute { PublicationRequestId = dead.Id, Slug = "retiring-device", UpstreamUrl = "https://origin.example/old/", Status = "Ready" });
        await db.SaveChangesAsync();

        var eligible = await applicant.GetFromJsonAsync<JsonElement>("/api/access-requests/eligible-apps");
        Assert.Contains(eligible.EnumerateArray(), x => x.GetProperty("name").GetString() == "受限设备");
        Assert.DoesNotContain("origin.example", eligible.ToString());
        var first = applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = app.Id, reason = "处理设备告警" });
        var second = applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = app.Id, reason = "处理设备告警" });
        var results = await Task.WhenAll(first, second);
        Assert.Equal(1, results.Count(x => x.IsSuccessStatusCode));
        Assert.Contains(results, x => x.StatusCode == HttpStatusCode.Conflict);

        var review = (await reviewer.GetFromJsonAsync<JsonElement>("/api/access-requests/reviewable")).EnumerateArray().Single();
        Assert.Equal("处理设备告警", review.GetProperty("reason").GetString());
        Assert.Equal("李俊", review.GetProperty("applicantName").GetString());
        Assert.Equal(HttpStatusCode.OK, (await applicant.GetAsync($"/api/access-requests/{review.GetProperty("id").GetGuid()}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await outsider.GetAsync($"/api/access-requests/{review.GetProperty("id").GetGuid()}")).StatusCode);

        var taskId = review.GetProperty("taskId").GetGuid();
        (await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{taskId}/complete", new { action = "approve", comment = "同意" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Conflict, (await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{taskId}/complete", new { action = "approve", comment = "再同意" })).StatusCode);
        Assert.Equal(1, await db.ApplicationPersonalGrants.CountAsync(x => x.PublicationRequestId == app.Id && x.RevokedAt == null));

        var deadSubmit = await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = dead.Id, reason = "仍需查看" });
        deadSubmit.EnsureSuccessStatusCode();
        var deadRoute = await db.ApplicationRoutes.SingleAsync(x => x.PublicationRequestId == dead.Id);
        deadRoute.Status = "Retired";
        await db.SaveChangesAsync();
        var deadReview = (await reviewer.GetFromJsonAsync<JsonElement>("/api/access-requests/reviewable")).EnumerateArray().Single();
        (await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{deadReview.GetProperty("taskId").GetGuid()}/complete", new { action = "approve", comment = "同意" })).EnsureSuccessStatusCode();
        var failed = await db.ApplicationAccessRequests.SingleAsync(x => x.PublicationRequestId == dead.Id);
        Assert.Equal(AccessRequestStatus.Failed, failed.Status);
        Assert.Contains("未授予", failed.ReviewComment);
        Assert.Equal(0, await db.ApplicationPersonalGrants.CountAsync(x => x.PublicationRequestId == dead.Id));

        var catalog = await applicant.GetStringAsync("/api/catalog/apps");
        Assert.Contains("受限设备", catalog);
        Assert.DoesNotContain("origin.example", catalog);
        var launch = await applicant.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        launch.EnsureSuccessStatusCode();
        var issued = await launch.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("limited-device", issued.GetProperty("slug").GetString());
        Assert.DoesNotContain("origin.example", issued.ToString());
        var grant = await db.ApplicationPersonalGrants.SingleAsync(x => x.PublicationRequestId == app.Id && x.RevokedAt == null);
        (await outsider.PostAsJsonAsync($"/api/gateway-settings/grants/{grant.Id}/revoke", new { reason = "收回" })).EnsureSuccessStatusCode();
        Assert.DoesNotContain("受限设备", await applicant.GetStringAsync("/api/catalog/apps"));
        Assert.Equal(HttpStatusCode.Forbidden, (await applicant.PostAsync($"/api/catalog/apps/{app.Id}/launch", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await applicant.GetAsync("/api/gateway-settings")).StatusCode);
    }

    [Fact]
    public async Task Registered_app_is_visible_and_only_final_approval_allows_the_applicant_to_enter()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var reviewer = await Login(factory, "wh00136");
        using var admin = await Login(factory, "wh00028");
        await PublishAccessProcess(admin, twoSteps: true);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var app = new RegisteredApplication
        {
            Name = "受限登记应用", CategoryId = (await db.Categories.FirstAsync()).Id,
            AccessUrl = "https://origin.example/registered", AccessMode = "Subjects"
        };
        db.RegisteredApplications.Add(app);
        await db.SaveChangesAsync();
        var entry = $"/api/catalog/registered-apps/{app.Id}/access";
        var apply = $"/api/catalog/registered-apps/{app.Id}/access-request";
        using var denial = await applicant.GetAsync(entry);
        Assert.Equal(HttpStatusCode.Forbidden, denial.StatusCode);
        Assert.Equal("application_access_required", (await denial.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var catalog = (await applicant.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray();
        Assert.Contains(catalog, x => x.GetProperty("id").GetGuid() == app.Id && x.GetProperty("accessUrl").GetString() == "");
        var eligible = (await applicant.GetFromJsonAsync<JsonElement>("/api/access-requests/eligible-apps")).EnumerateArray();
        Assert.Contains(eligible, x => x.GetProperty("id").GetGuid() == app.Id && x.GetProperty("registered").GetBoolean());

        using var submitted = await applicant.PostAsJsonAsync(apply, new { reason = "处理设备故障" });
        submitted.EnsureSuccessStatusCode();
        var requestId = (await submitted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Conflict, (await applicant.PostAsJsonAsync(apply, new { reason = "重复申请" })).StatusCode);

        for (var stage = 0; stage < 2; stage++)
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await applicant.GetAsync(entry)).StatusCode);
            var pending = (await reviewer.GetFromJsonAsync<JsonElement>("/api/access-requests/reviewable")).EnumerateArray().Single();
            Assert.Equal(app.Name, pending.GetProperty("appName").GetString());
            var taskId = pending.GetProperty("taskId").GetGuid();
            using var approved = await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{taskId}/complete", new { action = "approve" });
            approved.EnsureSuccessStatusCode();
        }

        var detail = await applicant.GetFromJsonAsync<JsonElement>($"/api/access-requests/{requestId}");
        Assert.Equal("Approved", detail.GetProperty("status").GetString());
        Assert.Equal(app.Name, detail.GetProperty("appName").GetString());
        var grant = await db.ApplicationPersonalGrants.SingleAsync(x => x.RegisteredApplicationId == app.Id);
        Assert.Equal(requestId, grant.AccessRequestId);
        Assert.Empty(await db.RegisteredApplicationGrants.Where(x => x.RegisteredApplicationId == app.Id).ToListAsync());
        using var launch = await applicant.PostAsJsonAsync(entry, new { visitId = Guid.NewGuid() });
        launch.EnsureSuccessStatusCode();
        Assert.Equal(app.AccessUrl, (await launch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessUrl").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await reviewer.GetAsync(entry)).StatusCode);
        var recent = (await applicant.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray();
        Assert.Contains(recent, x => x.GetProperty("id").GetGuid() == app.Id);

        (await admin.PostAsJsonAsync($"/api/gateway-settings/grants/{grant.Id}/revoke", new { reason = "收回" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Forbidden, (await applicant.GetAsync(entry)).StatusCode);
        Assert.DoesNotContain((await applicant.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray(),
            x => x.GetProperty("id").GetGuid() == app.Id);
    }

    [Fact]
    public async Task Ticket_session_and_settings_keep_their_own_deadlines()
    {
        using var factory = new Factory(new("https://portal.example"));
        using var user = await Login(factory, "wh00412");
        using var admin = await Login(factory, "wh00028");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var category = await db.Categories.FirstAsync();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var app = new PublicationRequest { RequestNo = "PUB-GW-1", AppName = "网关应用", Summary = "说明", CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All" };
        db.PublicationRequests.Add(app);
        db.ApplicationRoutes.Add(new ApplicationRoute { PublicationRequestId = app.Id, Slug = "gateway-app", UpstreamUrl = "https://origin.example/gw/", Status = "Ready" });
        await db.SaveChangesAsync();
        var launch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        var ticket = (await launch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString();
        var expired = await db.ApplicationLaunchTickets.SingleAsync();
        expired.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();
        using var content = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = ticket! });
        var stale = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        stale.DefaultRequestHeaders.Add("Origin", "https://portal.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await stale.PostAsync("/gateway-app", content)).StatusCode);

        expired.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(1);
        expired.ConsumedAt = null;
        await db.SaveChangesAsync();
        using var fresh = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = ticket! });
        var gateway = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        gateway.DefaultRequestHeaders.Add("Origin", "https://portal.example");
        var redeemed = await gateway.PostAsync("/gateway-app", fresh);
        Assert.Equal(HttpStatusCode.SeeOther, redeemed.StatusCode);
        Assert.Equal("/gateway-app/", redeemed.Headers.Location?.OriginalString);
        Assert.Contains("aigc_app_session", redeemed.Headers.GetValues("Set-Cookie").Single());
        using var replay = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = ticket! });
        Assert.Equal(HttpStatusCode.Forbidden, (await gateway.PostAsync("/gateway-app", replay)).StatusCode);
        var anonymous = factory.CreateClient();
        var bare = await anonymous.GetAsync("/gateway-app");
        Assert.Contains("请从 AIGC 应用集合进入此应用", await bare.Content.ReadAsStringAsync());
        var rooted = await gateway.GetAsync("/gateway-app/");
        var rootedBody = await rooted.Content.ReadAsStringAsync();
        Assert.DoesNotContain("请从 AIGC 应用集合进入此应用", rootedBody);
        Assert.DoesNotContain("请从 AIGC 应用集合打开此应用", rootedBody);

        var before = (await db.ApplicationGatewaySessions.SingleAsync()).AbsoluteExpiresAt;
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PutAsJsonAsync("/api/gateway-settings", new { idleTimeoutMinutes = 90, maxSessionHours = 1, launchTicketSeconds = 60 })).StatusCode);
        (await admin.PutAsJsonAsync("/api/gateway-settings", new { idleTimeoutMinutes = 15, maxSessionHours = 4, launchTicketSeconds = 30 })).EnsureSuccessStatusCode();
        Assert.Equal(before, (await db.ApplicationGatewaySessions.SingleAsync()).AbsoluteExpiresAt);
        Assert.Equal(1, await db.ApplicationGatewaySettingChanges.CountAsync());
    }

    [Theory]
    [InlineData(false, "127.0.0.1", false)]
    [InlineData(true, "127.0.0.1", true)]
    [InlineData(true, "origin.example", false)]
    public async Task Gateway_and_probe_accept_untrusted_tls_only_for_explicitly_allowed_hosts(
        bool acceptInvalidCertificate, string allowedHost, bool shouldForward)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=localhost", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var generated = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(1));
        using var certificate = X509CertificateLoader.LoadPkcs12(generated.Export(X509ContentType.Pfx), null);
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0, listener => listener.UseHttps(certificate)));
        await using var upstream = builder.Build();
        upstream.MapMethods("/business/", ["GET", "HEAD"], () => "源站已连接");
        await upstream.StartAsync();
        var address = upstream.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var upstreamUri = new Uri(new Uri(address), "/business/");

        using var factory = new Factory(new("https://portal.example"), useRealProbe: true, acceptInvalidCertificate, allowedHost);
        using var scope = factory.Services.CreateScope();
        var probe = scope.ServiceProvider.GetRequiredService<IUpstreamProbe>();
        Assert.Equal(shouldForward, await probe.ProbeAsync(upstreamUri, CancellationToken.None));

        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var category = await db.Categories.FirstAsync();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var app = new PublicationRequest
        {
            RequestNo = "PUB-GW-TLS", AppName = "TLS 应用", Summary = "说明", CategoryId = category.Id,
            ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All"
        };
        db.PublicationRequests.Add(app);
        db.ApplicationRoutes.Add(new ApplicationRoute
        {
            PublicationRequestId = app.Id, Slug = "gateway-tls", UpstreamUrl = upstreamUri.AbsoluteUri,
            Status = ApplicationRouteService.Ready
        });
        await db.SaveChangesAsync();

        using var user = await Login(factory, "wh00412");
        using var launch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        launch.EnsureSuccessStatusCode();
        var ticket = (await launch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!;
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        browser.DefaultRequestHeaders.Add("Origin", "https://portal.example");
        using var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = ticket });
        using var redeemed = await browser.PostAsync("/gateway-tls", form);
        Assert.Equal(HttpStatusCode.SeeOther, redeemed.StatusCode);
        using var page = await browser.GetAsync(redeemed.Headers.Location);
        var pageBody = await page.Content.ReadAsStringAsync();
        if (shouldForward)
        {
            Assert.Equal(HttpStatusCode.OK, page.StatusCode);
            Assert.Equal("源站已连接", pageBody);
        }
        else
        {
            Assert.Equal(HttpStatusCode.BadGateway, page.StatusCode);
            Assert.Equal("text/html; charset=utf-8", page.Content.Headers.ContentType?.ToString());
            Assert.Contains("<meta charset=\"utf-8\">", pageBody);
            Assert.All(pageBody, ch => Assert.True(char.IsAscii(ch)));
            Assert.Contains("<h1>应用暂时无法访问</h1>", WebUtility.HtmlDecode(pageBody));
        }
    }

    [Fact]
    public async Task Proxy_hostname_routes_root_assets_and_business_api_with_an_app_scoped_session()
    {
        const string suffix = "aigcplatform.boschhuayu-steering.com";
        const string slug = "proxy-app";
        const string otherSlug = "other-app";
        const string launchPath = "/.aigc/launch";
        var proxyOrigin = $"https://{slug}.{suffix}";
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        await using var upstream = builder.Build();
        upstream.MapGet("/login/start", () => "login page");
        var logo = new byte[] { 0x89, 0x50, 0x4e, 0x47 };
        upstream.MapGet("/brand/logo.png", () => Microsoft.AspNetCore.Http.Results.Bytes(logo, "image/png"));
        upstream.MapPost("/api/orders", (Microsoft.AspNetCore.Http.HttpContext ctx) =>
        {
            ctx.Response.Headers.Append("Set-Cookie", "business=new; Domain=127.0.0.1; Path=/; HttpOnly; Secure");
            ctx.Response.Headers.Append("Set-Cookie", "__Host-aigc_app_session=invalid; Path=/; Secure");
            ctx.Response.Headers.Append("Clear-Site-Data", "\"cookies\"");
            return Microsoft.AspNetCore.Http.Results.Ok(new
            {
                host = ctx.Request.Host.Value, path = ctx.Request.Path.Value, query = ctx.Request.QueryString.Value,
                cookies = ctx.Request.Headers.Cookie.ToString(), authorization = ctx.Request.Headers.Authorization.ToString(),
                origin = ctx.Request.Headers.Origin.ToString(), forwardedHost = ctx.Request.Headers["X-Forwarded-Host"].ToString()
            });
        });
        string source = "";
        upstream.MapGet("/api/redirect", () => Microsoft.AspNetCore.Http.Results.Redirect(source + "/login/start?next=1#section"));
        upstream.MapGet("/api/sso", () => Microsoft.AspNetCore.Http.Results.Redirect("https://issuer.example/login"));
        await upstream.StartAsync();
        source = upstream.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();

        using var factory = new Factory(new("https://portal.example"), proxyHostSuffix: suffix);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync();
        var app = new PublicationRequest { RequestNo = "PUB-PROXY", AppName = "代理应用", Summary = "说明", CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All" };
        var other = new PublicationRequest { RequestNo = "PUB-PROXY-OTHER", AppName = "另一应用", Summary = "说明", CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All" };
        db.PublicationRequests.AddRange(app, other);
        db.ApplicationRoutes.AddRange(new ApplicationRoute { PublicationRequestId = app.Id, Slug = slug, UpstreamUrl = source + "/login/start", Status = "Ready" },
            new ApplicationRoute { PublicationRequestId = other.Id, Slug = otherSlug, UpstreamUrl = source, Status = "Ready" });
        await db.SaveChangesAsync();

        using var user = await Login(factory, "wh00412");
        using var launch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        launch.EnsureSuccessStatusCode();
        var issued = await launch.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(proxyOrigin, issued.GetProperty("gatewayOrigin").GetString());
        Assert.Equal(launchPath, issued.GetProperty("launchPath").GetString());
        var token = issued.GetProperty("ticket").GetString()!;
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new(proxyOrigin), AllowAutoRedirect = false, HandleCookies = false });
        var anonymous = await browser.GetAsync("/api/orders");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        Assert.Contains("请从 AIGC 应用集合进入此应用", await anonymous.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync($"https://unknown-app.{suffix}/health")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await browser.GetAsync($"https://nested.{slug}.{suffix}/")).StatusCode);
        using var wrongHost = await Redeem($"https://{otherSlug}.{suffix}{launchPath}", "https://portal.example");
        Assert.Equal(HttpStatusCode.Forbidden, wrongHost.StatusCode);
        using var wrongOrigin = await Redeem(launchPath, "https://other.example");
        Assert.Equal(HttpStatusCode.Forbidden, wrongOrigin.StatusCode);
        using var redeemed = await Redeem(launchPath, "https://portal.example");
        Assert.Equal(HttpStatusCode.SeeOther, redeemed.StatusCode);
        Assert.Equal(proxyOrigin + "/login/start", redeemed.Headers.Location?.AbsoluteUri);
        var session = redeemed.Headers.GetValues("Set-Cookie").Single();
        Assert.StartsWith("__Host-aigc_app_session=", session);
        Assert.Contains("secure", session, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("domain=", session, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.Forbidden, (await Redeem(launchPath, "https://portal.example")).StatusCode);
        browser.DefaultRequestHeaders.Add("Cookie", session.Split(';')[0] + "; business=ok; aigc-portal-sso-pending=hidden");
        Assert.Equal("login page", await browser.GetStringAsync(redeemed.Headers.Location));
        Assert.Equal(logo, await browser.GetByteArrayAsync("/brand/logo.png"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync($"https://{otherSlug}.{suffix}/")).StatusCode);

        using var order = new HttpRequestMessage(HttpMethod.Post, "/api/orders?filter=open");
        order.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "business-token");
        order.Headers.Add("Origin", proxyOrigin);
        order.Headers.Add("X-Aigc-Ticket", "must-stay-at-gateway");
        using var response = await browser.SendAsync(order);
        response.EnsureSuccessStatusCode();
        var business = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("/api/orders", business.GetProperty("path").GetString());
        Assert.Equal("?filter=open", business.GetProperty("query").GetString());
        Assert.Equal(new Uri(source).Authority, business.GetProperty("host").GetString());
        Assert.Equal(source, business.GetProperty("origin").GetString());
        Assert.Equal(new Uri(proxyOrigin).Authority, business.GetProperty("forwardedHost").GetString());
        Assert.Equal("business=ok", business.GetProperty("cookies").GetString());
        Assert.Equal("Bearer business-token", business.GetProperty("authorization").GetString());
        var rewrittenCookie = response.Headers.GetValues("Set-Cookie").Single();
        Assert.StartsWith("business=new", rewrittenCookie);
        Assert.DoesNotContain("domain=", rewrittenCookie, StringComparison.OrdinalIgnoreCase);
        Assert.False(response.Headers.Contains("Clear-Site-Data"));
        Assert.Equal(proxyOrigin + "/login/start?next=1#section", (await browser.GetAsync("/api/redirect")).Headers.Location?.AbsoluteUri);
        Assert.Equal("https://issuer.example/login", (await browser.GetAsync("/api/sso")).Headers.Location?.AbsoluteUri);

        async Task<HttpResponseMessage> Redeem(string url, string origin)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            request.Headers.Add("Origin", origin);
            request.Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = token });
            return await browser.SendAsync(request);
        }
    }

    [Fact]
    public async Task Manual_deployment_callback_requires_process_admin_and_advances_the_current_call_once()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var applicant = await Login(factory, "wh00412");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var adminId = (await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028")).Id;
        var applicantId = (await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412")).Id;
        var definition = new ProcessDefinition
        {
            Key = "manual-deploy", Name = "手动部署测试", IsPublished = true,
            DefinitionJson = """
                {"executionMode":"integrated-v1","nodes":[
                    {"id":"deploy","type":"serviceTask","name":"部署","deploymentUrlField":"deployedAddress"},
                    {"id":"end","type":"end","name":"完成","result":"Approved"}],
                 "edges":[{"source":"deploy","target":"end","outcome":"succeeded"}]}
                """
        };
        var publication = new PublicationRequest
        {
            RequestNo = "PUB-MANUAL", AppName = "部署测试", Summary = "说明", ApplicantId = applicantId,
            CategoryId = (await db.Categories.FirstAsync()).Id, Status = PublicationStatus.Publishing
        };
        var instance = new WorkflowInstance
        {
            ProcessDefinitionId = definition.Id, BusinessId = publication.Id, BusinessType = "application-publication",
            InitiatorId = applicantId, CurrentNodeKey = "deploy", Status = WorkflowInstanceStatus.WaitingCallback
        };
        publication.ProcessInstanceId = instance.Id;
        var call = new IntegrationInvocation
        {
            InstanceId = instance.Id, NodeKey = "deploy", ServiceCode = "deployment", Operation = "deploy.submit.v1",
            ResultEvent = "deploy.completed.v1", Status = "DeliveryFailed", ExpiresAt = DateTimeOffset.UtcNow.AddHours(1)
        };
        var expired = new IntegrationInvocation
        {
            InstanceId = instance.Id, NodeKey = "deploy", ServiceCode = "deployment",
            ResultEvent = "deploy.completed.v1", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1)
        };
        var review = new IntegrationInvocation
        {
            InstanceId = instance.Id, NodeKey = "deploy", ServiceCode = "code-audit",
            ResultEvent = "audit.finished", ExpiresAt = DateTimeOffset.UtcNow.AddHours(1)
        };
        db.AddRange(definition, publication, instance, call, expired, review);
        await db.SaveChangesAsync();

        static string Trigger(Guid id) => $"/api/integrations/invocations/{id}/complete-deployment";
        var rows = await admin.GetFromJsonAsync<JsonElement>("/api/integrations/invocations");
        var triggerable = Assert.Single(rows.GetProperty("items").EnumerateArray(), row => row.GetProperty("canTriggerDeployment").GetBoolean());
        Assert.Equal(call.Id, triggerable.GetProperty("id").GetGuid());
        var input = new { deploymentUrl = "https://origin.example:8132/" };
        Assert.Equal(HttpStatusCode.Forbidden, (await applicant.PostAsJsonAsync(Trigger(call.Id), input)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync(Trigger(call.Id), new { deploymentUrl = "http://origin.example" })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync(Trigger(expired.Id), input)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await admin.PostAsJsonAsync(Trigger(review.Id), input)).StatusCode);
        var originalDefinition = definition.DefinitionJson;
        definition.DefinitionJson = originalDefinition.Replace("\"deploymentUrlField\"", "\"verifyCommit\":true,\"deploymentUrlField\"",
            StringComparison.Ordinal);
        await db.SaveChangesAsync();
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync(Trigger(call.Id), input)).StatusCode);
        definition.DefinitionJson = originalDefinition;
        await db.SaveChangesAsync();
        using var applied = await admin.PostAsJsonAsync(Trigger(call.Id), input);
        applied.EnsureSuccessStatusCode();
        Assert.False((await applied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("duplicate").GetBoolean());
        using var repeated = await admin.PostAsJsonAsync(Trigger(call.Id), input);
        repeated.EnsureSuccessStatusCode();
        Assert.True((await repeated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("duplicate").GetBoolean());

        var result = await db.PublicationRequests.AsNoTracking().SingleAsync(x => x.Id == publication.Id);
        Assert.Equal(PublicationStatus.Approved, result.Status);
        Assert.Equal(input.deploymentUrl, result.AccessUrl);
        Assert.Equal("Ready", (await db.ApplicationRoutes.AsNoTracking().SingleAsync(x => x.PublicationRequestId == publication.Id)).Status);
        var history = await db.WorkflowHistory.AsNoTracking().SingleAsync(x => x.InstanceId == instance.Id && x.EventType == "ManualDeploymentCompleted");
        Assert.Equal(adminId, history.ActorId);
        Assert.Equal(call.Id, (await db.IntegrationReceipts.AsNoTracking().SingleAsync()).InvocationId);
    }

    [Fact]
    public async Task Published_application_can_be_disabled_and_restored_without_reusing_old_credentials()
    {
        using var factory = new Factory(new("https://portal.example"));
        using var user = await Login(factory, "wh00412");
        using var other = await Login(factory, "wh00136");
        using var admin = await Login(factory, "wh00028");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var category = await db.Categories.FirstAsync();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var adminUser = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var app = new PublicationRequest
        {
            RequestNo = "PUB-OPS-1", AppName = "可停用应用", Summary = "说明", Version = "2.4.1",
            CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "Subjects"
        };
        var unready = new PublicationRequest
        {
            RequestNo = "PUB-OPS-2", AppName = "路由未就绪", Summary = "说明", Version = "0.9.0",
            CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All"
        };
        var publishing = new PublicationRequest
        {
            RequestNo = "PUB-OPS-3", AppName = "仍在发布", Summary = "说明", Version = "0.1.0",
            CategoryId = category.Id, ApplicantId = person.Id, Status = PublicationStatus.Publishing, AccessMode = "All"
        };
        db.PublicationRequests.AddRange(app, unready, publishing);
        db.PublicationAccessGrants.Add(new PublicationAccessGrant { PublicationRequestId = app.Id, SubjectType = "User", SubjectId = person.Id });
        db.ApplicationRoutes.AddRange(
            new ApplicationRoute { PublicationRequestId = app.Id, Slug = "ops-app", UpstreamUrl = "https://origin.example/ops/", Status = "Ready" },
            new ApplicationRoute { PublicationRequestId = unready.Id, Slug = "ops-unready", UpstreamUrl = "https://origin.example/wait/", Status = "Unavailable" });
        await db.SaveChangesAsync();
        Assert.True(app.OperationalEnabled);
        Assert.Equal(0, app.AccessEpoch);
        db.ChangeTracker.Clear();

        Assert.Contains((await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");
        Assert.DoesNotContain((await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "路由未就绪");
        Assert.Contains((await other.GetFromJsonAsync<JsonElement>("/api/access-requests/eligible-apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");
        Assert.Equal(HttpStatusCode.Forbidden, (await user.GetAsync("/api/application-registry/published")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await user.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = false })).StatusCode);

        var listed = (await admin.GetFromJsonAsync<JsonElement>("/api/application-registry/published")).EnumerateArray().ToList();
        Assert.Contains(listed, x => x.GetProperty("name").GetString() == "可停用应用" && x.GetProperty("version").GetString() == "2.4.1" && x.GetProperty("operationalEnabled").GetBoolean() && x.GetProperty("routeStatus").GetString() == "Ready");
        Assert.Contains(listed, x => x.GetProperty("name").GetString() == "路由未就绪" && x.GetProperty("routeStatus").GetString() == "Unavailable");
        Assert.DoesNotContain(listed, x => x.GetProperty("name").GetString() == "仍在发布");
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync($"/api/application-registry/published/{publishing.Id}/operational", new { enabled = false })).StatusCode);

        var firstLaunch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        firstLaunch.EnsureSuccessStatusCode();
        var oldTicket = (await firstLaunch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!;
        var secondLaunch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        secondLaunch.EnsureSuccessStatusCode();
        var sessionTicket = (await secondLaunch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!;
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        browser.DefaultRequestHeaders.Add("Origin", "https://portal.example");
        using var redeem = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = sessionTicket });
        var opened = await browser.PostAsync("/ops-app", redeem);
        Assert.Equal(HttpStatusCode.SeeOther, opened.StatusCode);
        var page = await browser.GetAsync("/ops-app/");
        Assert.DoesNotContain("请从 AIGC 应用集合进入此应用", await page.Content.ReadAsStringAsync());
        Assert.Contains((await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");

        var disabled = await admin.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = false });
        disabled.EnsureSuccessStatusCode();
        Assert.True((await disabled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("changed").GetBoolean());
        var repeated = await admin.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = false });
        repeated.EnsureSuccessStatusCode();
        Assert.False((await repeated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("changed").GetBoolean());
        db.ChangeTracker.Clear();
        var stopped = await db.PublicationRequests.SingleAsync(x => x.Id == app.Id);
        Assert.False(stopped.OperationalEnabled);
        Assert.Equal(1, stopped.AccessEpoch);
        Assert.Equal(PublicationStatus.Approved, stopped.Status);
        Assert.Equal("2.4.1", stopped.Version);
        Assert.Equal("Ready", (await db.ApplicationRoutes.SingleAsync(x => x.PublicationRequestId == app.Id)).Status);
        Assert.Equal(1, await db.PublicationAccessGrants.CountAsync(x => x.PublicationRequestId == app.Id));
        Assert.Equal(adminUser.Id, (await db.OperationAudits.SingleAsync(x => x.EntityId == app.Id.ToString())).UserId);
        Assert.DoesNotContain((await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");
        Assert.DoesNotContain((await user.GetFromJsonAsync<JsonElement>("/api/catalog/recent-apps")).EnumerateArray(), x => x.GetProperty("id").GetGuid() == app.Id);
        Assert.DoesNotContain((await other.GetFromJsonAsync<JsonElement>("/api/access-requests/eligible-apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");
        var rejected = await other.PostAsJsonAsync("/api/access-requests", new { applicationId = app.Id, reason = "停用后仍想申请" });
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Assert.Contains("已停用", await rejected.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Conflict, (await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null)).StatusCode);
        using var oldRedeem = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = oldTicket });
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsync("/ops-app", oldRedeem)).StatusCode);
        var closed = await browser.GetAsync("/ops-app/");
        Assert.Contains("请从 AIGC 应用集合进入此应用", await closed.Content.ReadAsStringAsync());

        var restored = await admin.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = true });
        restored.EnsureSuccessStatusCode();
        db.ChangeTracker.Clear();
        var resumed = await db.PublicationRequests.SingleAsync(x => x.Id == app.Id);
        Assert.True(resumed.OperationalEnabled);
        Assert.Equal(2, resumed.AccessEpoch);
        Assert.Equal("2.4.1", resumed.Version);
        Assert.Equal(PublicationStatus.Approved, resumed.Status);
        using var staleRedeem = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = oldTicket });
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsync("/ops-app", staleRedeem)).StatusCode);
        Assert.Contains("请从 AIGC 应用集合进入此应用", await (await browser.GetAsync("/ops-app/")).Content.ReadAsStringAsync());
        Assert.Contains((await user.GetFromJsonAsync<JsonElement>("/api/catalog/apps")).EnumerateArray(), x => x.GetProperty("name").GetString() == "可停用应用");
        var relaunch = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        relaunch.EnsureSuccessStatusCode();
        var freshTicket = (await relaunch.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!;
        using var freshRedeem = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = freshTicket });
        Assert.Equal(HttpStatusCode.SeeOther, (await browser.PostAsync("/ops-app", freshRedeem)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await user.PostAsync($"/api/catalog/apps/{unready.Id}/launch", null)).StatusCode);
        (await admin.PostAsJsonAsync($"/api/application-registry/published/{unready.Id}/operational", new { enabled = false })).EnsureSuccessStatusCode();
        (await admin.PostAsJsonAsync($"/api/application-registry/published/{unready.Id}/operational", new { enabled = true })).EnsureSuccessStatusCode();
        db.ChangeTracker.Clear();
        Assert.Equal("Unavailable", (await db.ApplicationRoutes.SingleAsync(x => x.PublicationRequestId == unready.Id)).Status);
        Assert.Equal("0.9.0", (await db.PublicationRequests.SingleAsync(x => x.Id == unready.Id)).Version);
        Assert.Equal(HttpStatusCode.Conflict, (await user.PostAsync($"/api/catalog/apps/{unready.Id}/launch", null)).StatusCode);
    }

    [Fact]
    public async Task Disable_invalidates_tickets_issued_beside_it()
    {
        using var factory = new Factory(new("https://portal.example"));
        using var user = await Login(factory, "wh00412");
        using var admin = await Login(factory, "wh00028");
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var person = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var app = new PublicationRequest
        {
            RequestNo = "PUB-OPS-RACE", AppName = "并发应用", Summary = "说明", Version = "3.0.0",
            CategoryId = (await db.Categories.FirstAsync()).Id, ApplicantId = person.Id, Status = PublicationStatus.Approved, AccessMode = "All"
        };
        db.PublicationRequests.Add(app);
        db.ApplicationRoutes.Add(new ApplicationRoute { PublicationRequestId = app.Id, Slug = "ops-race", UpstreamUrl = "https://origin.example/race/", Status = "Ready" });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var authorization = user.DefaultRequestHeaders.Authorization;
        var launches = Enumerable.Range(0, 8).Select(_ =>
        {
            var client = factory.CreateClient();
            client.DefaultRequestHeaders.Authorization = authorization;
            return client.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        }).ToArray();
        var disable = admin.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = false });
        var results = await Task.WhenAll(launches);
        var disabled = await disable;
        disabled.EnsureSuccessStatusCode();
        var issued = new List<string>();
        foreach (var result in results.Where(x => x.IsSuccessStatusCode))
            issued.Add((await result.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("ticket").GetString()!);
        db.ChangeTracker.Clear();
        var stopped = await db.PublicationRequests.SingleAsync(x => x.Id == app.Id);
        Assert.False(stopped.OperationalEnabled);
        var tickets = await db.ApplicationLaunchTickets.Where(x => x.PublicationRequestId == app.Id).ToListAsync();
        Assert.All(tickets, ticket => Assert.NotEqual(stopped.AccessEpoch, ticket.AccessEpoch));
        using var browser = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        browser.DefaultRequestHeaders.Add("Origin", "https://portal.example");
        foreach (var token in issued)
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = token });
            Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsync("/ops-race", form)).StatusCode);
        }
        (await admin.PostAsJsonAsync($"/api/application-registry/published/{app.Id}/operational", new { enabled = true })).EnsureSuccessStatusCode();
        foreach (var token in issued)
        {
            using var form = new FormUrlEncodedContent(new Dictionary<string, string> { ["ticket"] = token });
            Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsync("/ops-race", form)).StatusCode);
        }
        var fresh = await user.PostAsync($"/api/catalog/apps/{app.Id}/launch", null);
        fresh.EnsureSuccessStatusCode();
        db.ChangeTracker.Clear();
        var resumed = await db.PublicationRequests.SingleAsync(x => x.Id == app.Id);
        var current = await db.ApplicationLaunchTickets.OrderByDescending(x => x.CreatedAt).FirstAsync();
        Assert.Equal(resumed.AccessEpoch, current.AccessEpoch);
        Assert.Equal("Ready", (await db.ApplicationRoutes.SingleAsync(x => x.PublicationRequestId == app.Id)).Status);
    }

    private static async Task PublishAccessProcess(HttpClient admin, bool twoSteps = false)
    {
        var created = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key = "application-access", name = "访问申请审批", version = 1, isPublished = false, requestType = "access",
            definition = JsonDocument.Parse(twoSteps
                ? """
                    {"nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"初审","candidates":["role:workflow-admin"]},{"id":"final","type":"userTask","name":"终审","candidates":["role:workflow-admin"]},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"final"},{"source":"final","target":"end"}]}
                    """
                : """
                    {"nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"访问审核","candidates":["role:workflow-admin"]},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end"}]}
                    """).RootElement
        });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{id}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = "application-access" })).EnsureSuccessStatusCode();
    }

    private static async Task<Guid> FirstCategory(HttpClient client) =>
        (await client.GetFromJsonAsync<JsonElement>("/api/publication-requests/options")).EnumerateArray().First().GetProperty("id").GetGuid();

    private static async Task<HttpClient> Login(Factory factory, string employeeNo)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("accessToken").GetString());
        return client;
    }

    private sealed class Factory(Uri? origin = null, bool useRealProbe = false,
        bool acceptInvalidCertificate = false, string allowedHost = "origin.example", string? proxyHostSuffix = null) : WebApplicationFactory<Program>
    {
        private readonly string database = "gateway-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ApplicationGateway:HostEnabled"] = "true",
                ["ApplicationGateway:PublicOrigin"] = "https://aigcplatform-steering.com",
                ["ApplicationGateway:PortalHome"] = "https://aigcplatform-steering.com/",
                ["ApplicationGateway:AllowedSubmitOrigins:0"] = (origin ?? new Uri("https://aigcplatform-steering.com")).ToString().TrimEnd('/'),
                ["ApplicationGateway:AllowedUpstreamHosts:0"] = allowedHost,
                ["ApplicationGateway:ProxyHostSuffix"] = proxyHostSuffix,
                ["ApplicationGateway:AcceptInvalidUpstreamCertificates"] = acceptInvalidCertificate.ToString(),
                ["ApplicationGateway:Probe"] = "required"
            });
        }).ConfigureServices(services =>
        {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
            services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
            if (!useRealProbe)
            {
                services.RemoveAll<IUpstreamProbe>();
                services.AddSingleton<IUpstreamProbe>(new ReadyProbe());
            }
        });
        private sealed class ReadyProbe : IUpstreamProbe { public Task<bool> ProbeAsync(Uri upstream, CancellationToken ct) => Task.FromResult(true); }
    }
}
