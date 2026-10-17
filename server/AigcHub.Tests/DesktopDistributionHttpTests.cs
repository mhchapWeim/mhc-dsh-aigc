using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class DesktopDistributionHttpTests
{
    [Fact]
    public async Task CloudBackupsEnforceOwnershipForListingDownloadAndDeletion()
    {
        using var factory = new Factory();
        using var owner = await Login(factory, "wh00412", true);
        using var otherDesktop = await Login(factory, "wh00028", true);
        using var ownerPortal = await Login(factory, "wh00412", false);
        using var admin = await Login(factory, "wh00028", false);
        using var anonymous = factory.CreateClient();
        const string payload = "{\"version\":1,\"sessions\":[{\"header\":{\"id\":\"sample\"},\"events\":[]}]}";
        var sha256 = Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(payload)));
        var input = new { payload, sha256, scope = "selected" };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/v1/backups", input)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PostAsJsonAsync("/v1/backups", new { payload, sha256 = "bad", scope = "all" })).StatusCode);
        var uploaded = await owner.PostAsJsonAsync("/v1/backups", input);
        uploaded.EnsureSuccessStatusCode();
        var id = (await uploaded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var mine = await ownerPortal.GetFromJsonAsync<JsonElement>("/api/dsh-backups");
        Assert.Equal(1, mine.GetProperty("total").GetInt32());
        Assert.NotEqual(JsonValueKind.Null, mine.GetProperty("items")[0].GetProperty("lastLoginAt").ValueKind);
        var others = await otherDesktop.GetFromJsonAsync<JsonElement>("/v1/backups");
        Assert.Equal(0, others.GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.NotFound, (await otherDesktop.GetAsync($"/v1/backups/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await otherDesktop.DeleteAsync($"/v1/backups/{id}")).StatusCode);
        var managed = await admin.GetFromJsonAsync<JsonElement>("/api/dsh-backups");
        Assert.Equal(1, managed.GetProperty("total").GetInt32());
        Assert.False(managed.GetProperty("items")[0].GetProperty("canDownload").GetBoolean());
        (await admin.GetAsync($"/api/dsh-backups/{id}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"/api/dsh-backups/{id}/download")).StatusCode);
        var download = await owner.GetFromJsonAsync<JsonElement>($"/v1/backups/{id}");
        Assert.Equal(payload, download.GetProperty("payload").GetString());
        Assert.Equal(sha256, download.GetProperty("sha256").GetString());
        (await admin.DeleteAsync($"/api/dsh-backups/{id}")).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/v1/backups/{id}")).StatusCode);
    }

    [Fact]
    public async Task FeedbackIsPersistedWithAuthenticatedUserAndRestrictedToAdministrators()
    {
        using var factory = new Factory();
        using var desktop = await Login(factory, "wh00412", true);
        using var admin = await Login(factory, "wh00028", false);
        using var normal = await Login(factory, "wh00412", false);
        using var anonymous = factory.CreateClient();
        var input = new { sessionId = "feedback-session", category = "product-interaction", text = "页面操作问题", sessionLog = "Bearer sk-secret-value" };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/v1/feedback", input)).StatusCode);
        var receipt = await desktop.PostAsJsonAsync("/v1/feedback", input);
        receipt.EnsureSuccessStatusCode();
        var id = (await receipt.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var list = await admin.GetFromJsonAsync<JsonElement>("/api/dsh-feedback?search=页面&category=product-interaction");
        Assert.Equal(1, list.GetProperty("total").GetInt32());
        Assert.Equal("wh00412", list.GetProperty("items")[0].GetProperty("employeeNo").GetString());
        var detail = await admin.GetStringAsync($"/api/dsh-feedback/{id}");
        Assert.Contains("REDACTED", detail); Assert.DoesNotContain("sk-secret-value", detail);
        Assert.Equal(HttpStatusCode.Forbidden, (await normal.GetAsync("/api/dsh-feedback")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await normal.GetAsync($"/api/dsh-feedback/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await desktop.PostAsJsonAsync("/v1/feedback", new { sessionId = "s", category = "invalid", sessionLog = "" })).StatusCode);
    }

    [Fact]
    public async Task DiagnosticsAreAuthenticatedDeduplicatedScrubbedAndRestrictedToAdministrators()
    {
        using var factory = new Factory();
        using var desktop = await Login(factory, "wh00028", true);
        using var admin = await Login(factory, "wh00028", false);
        using var normal = await Login(factory, "wh00412", false);
        using var anonymous = factory.CreateClient();
        var eventId = Guid.NewGuid();
        var record = new { schemaVersion = 1, eventId, deviceId = Guid.NewGuid(), username = "wh00028", appVersion = "0.1.7-alpha.2.20261008.2",
            category = "tool", operation = "read_file", occurredAt = DateTimeOffset.UtcNow, sessionId = "session-1", operationId = "call-1",
            error = "upload failed Bearer sk-private-value password=secret-value", context = new[] { "tool started: read_file" },
            durationMs = 25, prompt = "must-not-be-stored", apiKey = "must-not-be-stored" };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = new[] { record } })).StatusCode);
        for (var i = 0; i < 2; i++)
        {
            var uploaded = await desktop.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = new[] { record } });
            uploaded.EnsureSuccessStatusCode();
            Assert.Equal(eventId, (await uploaded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("acceptedEventIds")[0].GetGuid());
        }
        var list = await admin.GetFromJsonAsync<JsonElement>("/api/dsh-failures?user=wh00028&category=tool&version=20261008&page=1");
        Assert.Equal(1, list.GetProperty("total").GetInt32());
        var id = list.GetProperty("items")[0].GetProperty("id").GetGuid();
        var detail = await admin.GetStringAsync($"/api/dsh-failures/{id}");
        Assert.Contains("[REDACTED", detail); Assert.DoesNotContain("sk-private-value", detail); Assert.DoesNotContain("secret-value", detail);
        Assert.DoesNotContain("must-not-be-stored", detail); Assert.Contains("call-1", detail);
        var download = await admin.GetAsync($"/api/dsh-failures/{id}/download");
        download.EnsureSuccessStatusCode(); Assert.Equal("application/x-ndjson", download.Content.Headers.ContentType?.MediaType);
        foreach (var path in new[] { "/api/dsh-failures", $"/api/dsh-failures/{id}", $"/api/dsh-failures/{id}/download" })
            Assert.Equal(HttpStatusCode.Forbidden, (await normal.GetAsync(path)).StatusCode);
        using var otherDesktop = await Login(factory, "wh00412", true);
        Assert.Equal(HttpStatusCode.BadRequest, (await otherDesktop.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = new[] { record } })).StatusCode);
        var malformed = new { schemaVersion = "wrong", eventId = Guid.NewGuid(), deviceId = Guid.NewGuid(), occurredAt = DateTimeOffset.UtcNow };
        Assert.Equal(HttpStatusCode.BadRequest, (await desktop.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = new[] { malformed } })).StatusCode);
    }

    [Fact]
    public async Task ExpiredDiagnosticsAreAcknowledgedWithoutStorageAndCleanedAfterSevenCalendarDays()
    {
        using var factory = new Factory();
        using var desktop = await Login(factory, "wh00028", true);
        var oldId = Guid.NewGuid();
        var expired = new { schemaVersion = 1, eventId = oldId, deviceId = Guid.NewGuid(), username = "wh00028", appVersion = "1.0.0",
            category = "llm", operation = "managed", occurredAt = DateTimeOffset.UtcNow.AddDays(-8), error = "timeout" };
        var receipt = await desktop.PostAsJsonAsync("/v1/desktop/diagnostics", new { events = new[] { expired } }); receipt.EnsureSuccessStatusCode();
        Assert.Equal(oldId, (await receipt.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("acceptedEventIds")[0].GetGuid());
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.Empty(await db.DshFailures.ToArrayAsync());
        var userId = await db.Users.Where(x => x.EmployeeNo == "wh00028").Select(x => x.Id).SingleAsync();
        db.DshFailures.AddRange(new DshFailure { UserId = userId, EventId = Guid.NewGuid(), OccurredAt = DshFailureCleanup.Cutoff.AddSeconds(-1) },
            new DshFailure { UserId = userId, EventId = Guid.NewGuid(), OccurredAt = DshFailureCleanup.Cutoff });
        await db.SaveChangesAsync(); await DshFailureCleanup.DeleteExpiredAsync(db, default);
        Assert.Single(await db.DshFailures.ToArrayAsync());
    }

    [Fact]
    public async Task VirtualKeyRoleGrantsArePersistedAndEnforcedForCurrentMembers()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028", false);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var actor = await db.Users.Include(x => x.Roles).SingleAsync(x => x.EmployeeNo == "wh00028");
        var other = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var roleId = actor.Roles.First().RoleId;
        var protector = scope.ServiceProvider.GetRequiredService<IDataProtectionProvider>().CreateProtector("AigcHub.ManagedVirtualKey.v1");
        var key = new ManagedVirtualKey { Alias = "角色测试", KeyProtected = protector.Protect("sk-role-test-fixture") };
        db.ManagedVirtualKeys.Add(key); await db.SaveChangesAsync();
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{key.Id}/grants", new { userIds = Array.Empty<Guid>(), departmentIds = Array.Empty<Guid>(),
            organizationIds = Array.Empty<Guid>(), roleIds = new[] { roleId } })).EnsureSuccessStatusCode();
        var grants = await admin.GetFromJsonAsync<JsonElement>($"/api/virtual-keys/{key.Id}/grants");
        Assert.Equal(roleId, grants.GetProperty("roleIds")[0].GetGuid());
        scope.ServiceProvider.GetRequiredService<IOptions<LiteLlmOptions>>().Value.PublicBaseUrl = "https://proxy.example.test/v1";
        var service = scope.ServiceProvider.GetRequiredService<LiteLlmVirtualKeyService>();
        Assert.Equal("sk-role-test-fixture", (await service.GetAsync(actor.Id, default)).ApiKey);
        await Assert.ThrowsAsync<WorkflowException>(() => service.GetAsync(other.Id, default));
        (await admin.PutAsJsonAsync($"/api/virtual-keys/{key.Id}/grants", new { userIds = new[] { other.Id }, departmentIds = Array.Empty<Guid>(),
            organizationIds = Array.Empty<Guid>(), roleIds = Array.Empty<Guid>() })).EnsureSuccessStatusCode();
        await Assert.ThrowsAsync<WorkflowException>(() => service.GetAsync(actor.Id, default));
        Assert.Equal("sk-role-test-fixture", (await service.GetAsync(other.Id, default)).ApiKey);
    }

    [Fact]
    public async Task RoleAndDepartmentAudiencesResolveDeduplicatedUsersAndRetainSelection()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028", false);
        var options = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-announcements/recipient-options");
        var person = options.GetProperty("users").EnumerateArray().Single(x => x.GetProperty("employeeNo").GetString() == "wh00028");
        var userId = person.GetProperty("id").GetGuid();
        var departmentId = person.GetProperty("departmentId").GetGuid();
        var roleId = person.GetProperty("roleIds")[0].GetGuid();
        var expected = options.GetProperty("users").EnumerateArray().Where(x => x.GetProperty("departmentId").GetGuid() == departmentId
            || x.GetProperty("roleIds").EnumerateArray().Any(r => r.GetGuid() == roleId)).Select(x => x.GetProperty("id").GetGuid()).Order().ToArray();
        var input = new { title = "组合范围", body = "部门、角色和指定用户", important = false, startsAt = DateTimeOffset.UtcNow,
            userIds = new[] { userId }, roleIds = new[] { roleId }, departmentIds = new[] { departmentId } };
        (await admin.PostAsJsonAsync("/api/desktop-announcements", input)).EnsureSuccessStatusCode();
        var announcements = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-announcements");
        var announcement = announcements.EnumerateArray().Single();
        Assert.Equal(expected, announcement.GetProperty("recipients").EnumerateArray().Select(x => x.GetProperty("userId").GetGuid()).Order().ToArray());
        Assert.Equal(roleId, announcement.GetProperty("audience").GetProperty("roleIds")[0].GetGuid());
        var created = await admin.PostAsJsonAsync("/api/desktop-releases", new { version = "1.2.3", notes = "", arch = "x64",
            userIds = Array.Empty<Guid>(), roleIds = new[] { roleId }, departmentIds = new[] { departmentId } });
        created.EnsureSuccessStatusCode();
        var releaseId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var releases = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-releases");
        Assert.Equal(expected.Length, releases[0].GetProperty("recipients").GetArrayLength());
        (await admin.PutAsJsonAsync($"/api/desktop-releases/{releaseId}/recipients", new { userIds = new[] { userId }, roleIds = Array.Empty<Guid>(), departmentIds = Array.Empty<Guid>() })).EnsureSuccessStatusCode();
        releases = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-releases");
        Assert.Single(releases[0].GetProperty("recipients").EnumerateArray());
        Assert.Equal(HttpStatusCode.BadRequest,
            (await admin.PostAsJsonAsync("/api/desktop-releases", new { version = "1.2.4", notes = "", arch = "x64", userIds = Array.Empty<Guid>(), roleIds = new[] { Guid.NewGuid() } })).StatusCode);
    }

    [Theory]
    [InlineData("1.0.0", "1.0.0-rc.1", 1)]
    [InlineData("1.0.0-alpha.10", "1.0.0-alpha.2", 1)]
    [InlineData("1.9.0", "1.10.0", -1)]
    [InlineData("1.0.0+build.2", "1.0.0+build.1", 0)]
    public void VersionOrderFollowsSemVer(string left, string right, int sign) => Assert.Equal(sign, Math.Sign(DesktopVersion.Compare(left, right)));

    [Fact]
    public async Task AnnouncementsAreTargetedScheduledAndKeepMonotonicReceipts()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028", false);
        using var recipient = await Login(factory, "wh00028", true);
        using var other = await Login(factory, "wh00412", true);
        var users = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-announcements/recipients");
        var userId = users.EnumerateArray().Single(x => x.GetProperty("employeeNo").GetString() == "wh00028").GetProperty("id").GetGuid();
        var response = await admin.PostAsJsonAsync("/api/desktop-announcements", new {
            title = "测试公告", body = "保留离线公告", important = true, startsAt = DateTimeOffset.UtcNow.AddMinutes(-1), endsAt = DateTimeOffset.UtcNow.AddDays(1), userIds = new[] { userId }
        });
        response.EnsureSuccessStatusCode();
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Empty((await recipient.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items").EnumerateArray());
        (await admin.PostAsJsonAsync($"/api/desktop-announcements/{id}/status", new { status = "Published" })).EnsureSuccessStatusCode();
        Assert.Single((await recipient.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items").EnumerateArray());
        Assert.Empty((await other.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items").EnumerateArray());
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsJsonAsync($"/v1/desktop/announcements/{id}/receipt", new { status = "Read" })).StatusCode);
        foreach (var status in new[] { "Confirmed", "Delivered", "Read" })
            (await recipient.PostAsJsonAsync($"/v1/desktop/announcements/{id}/receipt", new { status })).EnsureSuccessStatusCode();
        var item = (await recipient.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items")[0];
        Assert.Equal(JsonValueKind.String, item.GetProperty("confirmedAt").ValueKind);
        Assert.Equal(JsonValueKind.String, item.GetProperty("readAt").ValueKind);
        (await admin.PostAsJsonAsync($"/api/desktop-announcements/{id}/status", new { status = "Withdrawn" })).EnsureSuccessStatusCode();
        Assert.Empty((await recipient.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items").EnumerateArray());
        var scheduled = await admin.PostAsJsonAsync("/api/desktop-announcements", new {
            title = "定时", body = "尚未生效", important = false, startsAt = DateTimeOffset.UtcNow.AddDays(1), userIds = new[] { userId }
        });
        scheduled.EnsureSuccessStatusCode();
        var futureId = (await scheduled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsJsonAsync($"/api/desktop-announcements/{futureId}/status", new { status = "Published" })).EnsureSuccessStatusCode();
        Assert.Empty((await recipient.GetFromJsonAsync<JsonElement>("/v1/desktop/announcements")).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task GrayReleaseUsesAuthenticatedFeedImmutableFilesAndRangeDownloads()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028", false);
        using var recipient = await Login(factory, "wh00028", true);
        using var other = await Login(factory, "wh00412", true);
        var people = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-releases/recipients");
        var userId = people.EnumerateArray().Single(x => x.GetProperty("employeeNo").GetString() == "wh00028").GetProperty("id").GetGuid();
        var payload = new { version = "1.2.0", notes = "版本说明", arch = "x64", userIds = new[] { userId } };
        var created = await admin.PostAsJsonAsync("/api/desktop-releases", payload);
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/api/desktop-releases", payload)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Published" })).StatusCode);
        var bytes = "MZ test installer"u8.ToArray();
        using var upload = new MultipartFormDataContent(); upload.Add(new ByteArrayContent(bytes), "installer", "bhss-1.2.0.exe");
        (await admin.PostAsync($"/api/desktop-releases/{id}/artifacts", upload)).EnsureSuccessStatusCode();
        using var duplicate = new MultipartFormDataContent(); duplicate.Add(new ByteArrayContent(bytes), "installer", "bhss-1.2.0.exe");
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsync($"/api/desktop-releases/{id}/artifacts", duplicate)).StatusCode);
        (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Published" })).EnsureSuccessStatusCode();
        var identity = new { deviceId = "test-device", computerName = "test-pc", version = "1.0.0", platform = "win32", arch = "x64" };
        var assigned = await recipient.PostAsJsonAsync("/v1/desktop/check", identity); assigned.EnsureSuccessStatusCode();
        Assert.Equal(id, (await assigned.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("release").GetProperty("id").GetGuid());
        var excluded = await other.PostAsJsonAsync("/v1/desktop/check", identity);
        Assert.Equal(JsonValueKind.Null, (await excluded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("release").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/v1/desktop/updates/{id}/nightly.yml")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/v1/desktop/updates/{id}/bhss-1.2.0.exe")).StatusCode);
        var manifest = await recipient.GetStringAsync($"/v1/desktop/updates/{id}/nightly.yml");
        Assert.Contains(Convert.ToBase64String(SHA512.HashData(bytes)), manifest);
        using var range = new HttpRequestMessage(HttpMethod.Get, $"/v1/desktop/updates/{id}/bhss-1.2.0.exe"); range.Headers.Range = new RangeHeaderValue(0, 1);
        var ranged = await recipient.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, ranged.StatusCode); Assert.Equal("MZ"u8.ToArray(), await ranged.Content.ReadAsByteArrayAsync());
        var current = await recipient.PostAsJsonAsync("/v1/desktop/check", new { identity.deviceId, identity.computerName, version = "1.2.0", identity.platform, identity.arch });
        Assert.Equal(JsonValueKind.Null, (await current.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("release").ValueKind);
        (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Paused" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await recipient.GetAsync($"/v1/desktop/updates/{id}/nightly.yml")).StatusCode);
        using var normalPortal = await Login(factory, "wh00412", false);
        Assert.Equal(HttpStatusCode.Forbidden, (await normalPortal.GetAsync("/api/desktop-releases")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await normalPortal.GetAsync("/api/desktop-announcements")).StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/v1/desktop/announcements")).StatusCode);
    }

    [Fact]
    public async Task FirstInstallUsesPortalIdentityAndRechecksAudienceAndPublicationForDownload()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028", false);
        using var recipient = await Login(factory, "wh00412", false);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/desktop-downloads/windows-x64")).StatusCode);
        var initial = await recipient.GetFromJsonAsync<JsonElement>("/api/desktop-downloads/windows-x64");
        Assert.Equal(JsonValueKind.Null, initial.GetProperty("release").ValueKind);
        var people = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-releases/recipients");
        var userId = people.EnumerateArray().Single(x => x.GetProperty("employeeNo").GetString() == "wh00412").GetProperty("id").GetGuid();
        var created = await admin.PostAsJsonAsync("/api/desktop-releases", new { version = "3.0.0", notes = "首次安装", arch = "x64", userIds = new[] { userId } });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        using var upload = new MultipartFormDataContent();
        upload.Add(new ByteArrayContent("MZ first installer"u8.ToArray()), "installer", "bhssAiWork-3.0.0.exe");
        (await admin.PostAsync($"/api/desktop-releases/{id}/artifacts", upload)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await recipient.PostAsync($"/api/desktop-downloads/{id}/ticket", null)).StatusCode);
        (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Published" })).EnsureSuccessStatusCode();
        var latest = await recipient.GetFromJsonAsync<JsonElement>("/api/desktop-downloads/windows-x64");
        Assert.Equal(id, latest.GetProperty("release").GetProperty("id").GetGuid());
        var unauthorizedVersion = await admin.GetFromJsonAsync<JsonElement>("/api/desktop-downloads/windows-x64");
        Assert.Equal(JsonValueKind.Null, unauthorizedVersion.GetProperty("release").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.PostAsync($"/api/desktop-downloads/{id}/ticket", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync($"/api/desktop-downloads/{id}/installer")).StatusCode);
        using var forged = factory.CreateClient();
        forged.DefaultRequestHeaders.Add("Cookie", $"aigc-desktop-download-{id:N}=forged-cookie");
        Assert.Equal(HttpStatusCode.Unauthorized, (await forged.GetAsync($"/api/desktop-downloads/{id}/installer")).StatusCode);
        var ticket = await recipient.PostAsync($"/api/desktop-downloads/{id}/ticket", null);
        ticket.EnsureSuccessStatusCode();
        Assert.Contains(ticket.Headers.GetValues("Set-Cookie"), value => value.Contains("httponly", StringComparison.OrdinalIgnoreCase));
        using var range = new HttpRequestMessage(HttpMethod.Get, $"/api/desktop-downloads/{id}/installer");
        range.Headers.Range = new RangeHeaderValue(0, 1);
        var download = await recipient.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, download.StatusCode);
        Assert.Equal("MZ"u8.ToArray(), await download.Content.ReadAsByteArrayAsync());
        Assert.Contains("bhssAiWork-3.0.0.exe", download.Content.Headers.ContentDisposition!.ToString());
        (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Paused" })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await recipient.GetAsync($"/api/desktop-downloads/{id}/installer")).StatusCode);
        using var scope = factory.Services.CreateScope();
        (await admin.PostAsJsonAsync($"/api/desktop-releases/{id}/status", new { status = "Published" })).EnsureSuccessStatusCode();
        var storage = scope.ServiceProvider.GetRequiredService<Microsoft.Extensions.Configuration.IConfiguration>()["DesktopReleases:Root"]!;
        File.Delete(Path.Combine(storage, id.ToString("N"), "installer.exe"));
        var missing = await recipient.GetFromJsonAsync<JsonElement>("/api/desktop-downloads/windows-x64");
        Assert.Equal(JsonValueKind.Null, missing.GetProperty("release").ValueKind);
        Assert.Equal(HttpStatusCode.NotFound, (await recipient.PostAsync($"/api/desktop-downloads/{id}/ticket", null)).StatusCode);
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<AigcHubDbContext>().DesktopClientReports.ToArrayAsync());
    }

    private static async Task<HttpClient> Login(Factory factory, string user, bool desktop)
    {
        var client = factory.CreateClient();
        var response = desktop ? await client.PostAsJsonAsync("/v1/auth/login", new { username = user, password = "Bhss@123" })
            : await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = user, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", result.GetProperty(desktop ? "access_token" : "accessToken").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "desktop-distribution-" + Guid.NewGuid().ToString("N"));
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("DesktopReleases:Root", root);
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.UseSetting("FileLogging:Directory", Path.Combine(root, "logs"));
            builder.ConfigureServices(services => {
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
