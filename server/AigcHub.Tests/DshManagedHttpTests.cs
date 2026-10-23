using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Endpoints;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class DshManagedHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BothLoginMethodsRenewAfterRestartAndRevokeThePersistentSession(bool sso)
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-persistent-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false });
            JsonElement login;
            if (sso)
            {
                var start = await client.PostAsync("/v1/auth/cas/device", null);
                start.EnsureSuccessStatusCode();
                var device = await start.Content.ReadFromJsonAsync<JsonElement>();
                var code = device.GetProperty("device_code").GetString();
                Assert.Equal(HttpStatusCode.Redirect, (await client.GetAsync($"/v1/auth/cas/start?device_code={code}")).StatusCode);
                (await client.GetAsync("/v1/auth/cas/callback?ticket=test-ticket")).EnsureSuccessStatusCode();
                login = await client.GetFromJsonAsync<JsonElement>($"/v1/auth/cas/device/{code}");
                var retried = await client.GetFromJsonAsync<JsonElement>($"/v1/auth/cas/device/{code}");
                Assert.Equal(login.GetProperty("access_token").GetString(), retried.GetProperty("access_token").GetString());
            }
            else
            {
                var response = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
                response.EnsureSuccessStatusCode();
                login = await response.Content.ReadFromJsonAsync<JsonElement>();
            }
            var access = login.GetProperty("access_token").GetString()!;
            var refresh = login.GetProperty("refresh_token").GetString()!;
            Assert.NotEqual(access, refresh);
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
                var token = await db.DshAccessTokens.SingleAsync();
                token.ExpiresAt = DateTimeOffset.UtcNow.AddDays(-2);
                await db.SaveChangesAsync();
                Assert.DoesNotContain(access, token.TokenHash);
                Assert.DoesNotContain(refresh, (await db.DshPersistentSessions.SingleAsync()).RefreshTokenHash);
            }
            using var reopened = factory.CreateClient();
            reopened.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", access);
            Assert.Equal(HttpStatusCode.Unauthorized, (await reopened.GetAsync("/v1/auth/me")).StatusCode);
            reopened.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", refresh);
            Assert.Equal(HttpStatusCode.Unauthorized, (await reopened.GetAsync("/v1/auth/me")).StatusCode);
            var renewal = await reopened.PostAsync("/v1/auth/refresh", null);
            renewal.EnsureSuccessStatusCode();
            var renewed = await renewal.Content.ReadFromJsonAsync<JsonElement>();
            var newAccess = renewed.GetProperty("access_token").GetString();
            Assert.NotEqual(access, newAccess);
            reopened.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", newAccess);
            (await reopened.GetAsync("/v1/auth/me")).EnsureSuccessStatusCode();
            // Revocation accepts the persistent credential even if the access token expired.
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", refresh);
            (await client.PostAsync("/v1/auth/logout", null)).EnsureSuccessStatusCode();
            Assert.Equal(HttpStatusCode.Unauthorized, (await reopened.GetAsync("/v1/auth/me")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/v1/auth/refresh", null)).StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task WebSearchRequiresLoginAndGrantAndKeepsDeepSeekKeyOnServer()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-search-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var upstream = new SearchReplyHandler();
            using var factory = new Factory(root, search: () => upstream);
            using var anonymous = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await anonymous.PostAsJsonAsync("/v1/web-search", new { query = "test" })).StatusCode);
            using var dsh = factory.CreateClient();
            var dshLogin = await dsh.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            using var dshBody = JsonDocument.Parse(await dshLogin.Content.ReadAsStringAsync());
            dsh.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                dshBody.RootElement.GetProperty("access_token").GetString());
            Assert.Equal(HttpStatusCode.Forbidden,
                (await dsh.PostAsJsonAsync("/v1/web-search", new { query = "test" })).StatusCode);

            using var admin = factory.CreateClient();
            var adminLogin = await admin.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
            using var adminBody = JsonDocument.Parse(await adminLogin.Content.ReadAsStringAsync());
            admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                adminBody.RootElement.GetProperty("accessToken").GetString());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
            var saved = await admin.PutAsJsonAsync("/api/web-search", new
            {
                apiKey = "sk-server-only", isEnabled = true,
                grants = new { userIds = Array.Empty<Guid>(), roleIds = Array.Empty<Guid>(), departmentIds = new[] { user.DepartmentId } }
            });
            Assert.Equal(HttpStatusCode.NoContent, saved.StatusCode);
            var settings = await admin.GetFromJsonAsync<JsonElement>("/api/web-search");
            Assert.True(settings.GetProperty("hasApiKey").GetBoolean());
            Assert.False(settings.ToString().Contains("sk-server-only", StringComparison.Ordinal));
            var search = await dsh.PostAsJsonAsync("/v1/web-search", new { query = "test" });
            Assert.Equal(HttpStatusCode.OK, search.StatusCode);
            var results = await search.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("https://example.test", results.GetProperty("sources")[0].GetProperty("url").GetString());
            Assert.False(results.GetProperty("sources")[0].TryGetProperty("snippet", out _));
            Assert.False(results.GetProperty("sources")[0].TryGetProperty("publishedAt", out _));
            Assert.Equal("sk-server-only", upstream.ApiKey);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task SensitiveWordCatalogRequiresDshLoginAndReturnsOnlyEnabledRules()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var admin = factory.CreateClient();
            var adminLogin = await admin.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
            using var adminBody = JsonDocument.Parse(await adminLogin.Content.ReadAsStringAsync());
            admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                adminBody.RootElement.GetProperty("accessToken").GetString());

            var enabled = await admin.PostAsJsonAsync("/api/sensitive-words", new { term = "机密项目，外传、外发;外泄；泄露", isEnabled = true });
            var disabled = await admin.PostAsJsonAsync("/api/sensitive-words", new { term = "历史规则", isEnabled = false });
            Assert.Equal(HttpStatusCode.OK, enabled.StatusCode);
            Assert.Equal(HttpStatusCode.OK, disabled.StatusCode);
            Assert.Equal(HttpStatusCode.Conflict,
                (await admin.PostAsJsonAsync("/api/sensitive-words", new { term = "  机密项目，外传、外发;外泄；泄露  ", isEnabled = true })).StatusCode);

            using var dsh = factory.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await dsh.GetAsync("/v1/sensitive-words")).StatusCode);
            var dshLogin = await dsh.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            using var dshBody = JsonDocument.Parse(await dshLogin.Content.ReadAsStringAsync());
            dsh.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                dshBody.RootElement.GetProperty("access_token").GetString());

            var catalog = await dsh.GetFromJsonAsync<JsonElement>("/v1/sensitive-words");
            Assert.Equal(new[] { "机密项目", "外传", "外发", "外泄", "泄露" }, catalog.GetProperty("words").EnumerateArray().Select(x => x.GetString()));
            Assert.NotEqual("0", catalog.GetProperty("revision").GetString());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task BatchListingKeepsFilesFromOneSubmissionOnTheSamePage()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
            using var loginBody = JsonDocument.Parse(await login.Content.ReadAsStringAsync());
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                loginBody.RootElement.GetProperty("accessToken").GetString());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var user = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
            var createdAt = DateTimeOffset.UtcNow;
            foreach (var (name, seq, completed, offset) in new[]
            {
                ("first.txt", 4L, true, 10L),
                ("second.txt", 4L, false, 5L),
                ("third.txt", 5L, true, 10L)
            })
            {
                db.DshUploads.Add(new DshUpload
                {
                    UserId = user.Id, ClientUploadId = name, SessionId = "session-1", EventSeq = seq,
                    Prompt = "inspect", DeviceId = "device-1", ComputerName = "test-host",
                    StoredPath = $@"C:\stored\{name}", FileName = name, Sha256 = new string('a', 64),
                    Bytes = 10, Offset = offset, Completed = completed, CreatedAt = createdAt.AddMinutes(seq)
                });
            }
            await db.SaveChangesAsync();

            var firstPage = await client.GetFromJsonAsync<JsonElement>("/api/dsh-uploads/batches?page=1&pageSize=1");
            var secondPage = await client.GetFromJsonAsync<JsonElement>("/api/dsh-uploads/batches?page=2&pageSize=1");
            Assert.Equal(2, firstPage.GetProperty("total").GetInt32());
            Assert.Single(firstPage.GetProperty("items").EnumerateArray());
            Assert.Single(secondPage.GetProperty("items").EnumerateArray());
            Assert.Equal(5, firstPage.GetProperty("items")[0].GetProperty("eventSeq").GetInt32());
            var secondBatchFiles = secondPage.GetProperty("items")[0].GetProperty("files");
            Assert.Equal(2, secondBatchFiles.GetArrayLength());
            Assert.Equal(new[] { "first.txt", "second.txt" }, secondBatchFiles.EnumerateArray()
                .Select(x => x.GetProperty("fileName").GetString()).OrderBy(x => x));

            var filtered = await client.GetFromJsonAsync<JsonElement>(
                "/api/dsh-uploads/batches?query=second.txt&status=Uploading");
            Assert.Equal(1, filtered.GetProperty("total").GetInt32());
            Assert.Equal(2, filtered.GetProperty("items")[0].GetProperty("files").GetArrayLength());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task AttachmentReviewRecordsMetadataWithoutAcceptingFileContents()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            using var loginBody = JsonDocument.Parse(await login.Content.ReadAsStringAsync());
            var token = loginBody.RootElement.GetProperty("access_token").GetString();
            var userId = loginBody.RootElement.GetProperty("user").GetProperty("id").GetGuid();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

            var bytes = "abcdef"u8.ToArray();
            var metadata = new {
                userId, clientUploadId = "damaged-upload", sessionId = "session-1", eventSeq = 1,
                prompt = "inspect", deviceId = "device-1", computerName = "test-host",
                storedPath = @"C:\stored\model.onnx", fileName = "model.onnx",
                bytes = bytes.Length, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes))
            };
            var registered = await client.PostAsJsonAsync("/v1/uploads", metadata);
            Assert.Equal(HttpStatusCode.OK, registered.StatusCode);
            var acknowledgement = await registered.Content.ReadFromJsonAsync<JsonElement>();
            // The released worker checks completed before reading content or validating offsets.
            Assert.True(acknowledgement.GetProperty("completed").GetBoolean());
            Assert.Equal(bytes.Length, acknowledgement.GetProperty("bytes").GetInt64());
            Assert.Equal(0, acknowledgement.GetProperty("offset").GetInt64());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var upload = await db.DshUploads.SingleAsync();
            Assert.Equal("model.onnx", upload.FileName);
            Assert.Equal("inspect", upload.Prompt);
            Assert.Equal("test-host", upload.ComputerName);
            Assert.Equal(@"C:\stored\model.onnx", upload.StoredPath);
            Assert.Equal(bytes.Length, upload.Bytes);
            Assert.Equal("", upload.Sha256);
            Assert.True(upload.Completed);
            Assert.Equal(0, upload.Offset);
            Assert.Empty(Directory.GetFiles(root));
            var resumed = await client.PostAsJsonAsync("/v1/uploads", metadata);
            Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
            Assert.Equal(1, await db.DshUploads.CountAsync());
            using var chunk = new ByteArrayContent(bytes);
            Assert.Equal(HttpStatusCode.Gone, (await client.PutAsync("/v1/uploads/damaged-upload/chunk?offset=0", chunk)).StatusCode);
            Assert.Empty(Directory.GetFiles(root));
            // New clients do not send a file digest at all.
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/uploads", new {
                userId, clientUploadId = "metadata-2", sessionId = "session-1", eventSeq = 2,
                prompt = "inspect", deviceId = "device-1", computerName = "test-host",
                storedPath = @"C:\stored\report.txt", fileName = "report.txt", bytes = 123
            })).StatusCode);

            // An interrupted task from an older client becomes metadata-only on retry.
            upload.Completed = false;
            upload.Offset = 3;
            upload.Sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
            await db.SaveChangesAsync();
            var part = Path.Combine(root, $"{upload.Id:N}.part");
            await File.WriteAllBytesAsync(part, bytes[..3]);
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/uploads", metadata)).StatusCode);
            await db.Entry(upload).ReloadAsync();
            Assert.True(upload.Completed);
            Assert.Equal("", upload.Sha256);
            Assert.Equal(0, upload.Offset);
            Assert.Equal(bytes[..3], await File.ReadAllBytesAsync(part));
            Assert.False(File.Exists(Path.Combine(root, $"{upload.Id:N}.bin")));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Theory]
    [InlineData("status")]
    [InlineData("complete")]
    [InlineData("chunk")]
    public async Task InstalledClientsStopInterruptedUploadsWithoutChangingStoredFiles(string operation)
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            var session = await login.Content.ReadFromJsonAsync<JsonElement>();
            var userId = session.GetProperty("user").GetProperty("id").GetGuid();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("access_token").GetString());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var record = new DshUpload {
                UserId = userId, ClientUploadId = "old-task", SessionId = "old-session", EventSeq = 5,
                Prompt = "inspect", DeviceId = "old-device", ComputerName = "old-pc", StoredPath = @"D:\work\old.txt",
                FileName = "old.txt", Bytes = 6, Offset = 3, Sha256 = new string('a', 64), Completed = false
            };
            db.DshUploads.Add(record);
            await db.SaveChangesAsync();
            var part = Path.Combine(root, $"{record.Id:N}.part");
            await File.WriteAllBytesAsync(part, "abc"u8.ToArray());
            var route = "/v1/uploads/old-task";
            using var response = operation switch {
                "status" => await client.GetAsync(route),
                "complete" => await client.PostAsync($"{route}/complete", null),
                _ => await client.PutAsync($"{route}/chunk?offset=3", new StringContent("def"))
            };
            Assert.Equal(operation == "chunk" ? HttpStatusCode.Gone : HttpStatusCode.OK, response.StatusCode);
            // The released worker retries from registration after a refused in-flight chunk.
            using var retry = await client.PostAsJsonAsync("/v1/uploads", new {
                userId, clientUploadId = "old-task", sessionId = "old-session", eventSeq = 5, prompt = "inspect",
                deviceId = "old-device", computerName = "old-pc", storedPath = @"D:\work\old.txt", fileName = "old.txt",
                bytes = 6, sha256 = new string('a', 64)
            });
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
            Assert.True((await retry.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("completed").GetBoolean());
            await db.Entry(record).ReloadAsync();
            Assert.True(record.Completed);
            Assert.Equal("", record.Sha256);
            Assert.Equal(0, record.Offset);
            Assert.Equal("abc"u8.ToArray(), await File.ReadAllBytesAsync(part));
            Assert.Single(Directory.GetFiles(root));
            Assert.Single(await db.DshUploads.ToArrayAsync());

            client.DefaultRequestHeaders.Authorization = null;
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route)).StatusCode);
            var otherLogin = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00412", password = "Bhss@123" });
            var other = await otherLogin.Content.ReadFromJsonAsync<JsonElement>();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", other.GetProperty("access_token").GetString());
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(route)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"{route}/complete", null)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.PutAsync($"{route}/chunk?offset=0", new StringContent("secret"))).StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task LoginGrantsAndAttachmentRecordsUseTheAuthenticatedUser()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient();
            var rejected = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "wrong" });
            Assert.Equal(HttpStatusCode.Unauthorized, rejected.StatusCode);
            var login = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            Assert.Equal(HttpStatusCode.OK, login.StatusCode);
            using var loginBody = JsonDocument.Parse(await login.Content.ReadAsStringAsync());
            var token = loginBody.RootElement.GetProperty("access_token").GetString();
            var userId = loginBody.RootElement.GetProperty("user").GetProperty("id").GetGuid();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var model = new AiModelConfiguration { Name = "test-model", ProviderKind = "LiteLLM", BaseUrl = "https://model.example.test", ModelIdentifier = "model-1" };
            db.ModelConfigurations.Add(model);
            await db.SaveChangesAsync();
            using var admin = factory.CreateClient();
            var modelAdminLogin = await admin.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
            using var modelAdminBody = JsonDocument.Parse(await modelAdminLogin.Content.ReadAsStringAsync());
            admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                modelAdminBody.RootElement.GetProperty("accessToken").GetString());
            var toolAudit = await client.PostAsJsonAsync("/v1/tool-audits", new {
                sessionId = "session-1", callId = "call-1", toolName = "web_search", succeeded = true,
                errorCode = (string?)null
            });
            Assert.Equal(HttpStatusCode.NoContent, toolAudit.StatusCode);
            var audits = await admin.GetFromJsonAsync<JsonElement>("/api/operation-audits");
            Assert.Contains(audits.GetProperty("items").EnumerateArray(), x => x.GetProperty("entityType").GetString() == "DshTool"
                && x.GetProperty("action").GetString() == "web_search");
            Assert.All(audits.GetProperty("items").EnumerateArray(), x =>
                Assert.Equal("姚伟明", x.GetProperty("actorName").GetString()));
            var adminModels = await admin.GetFromJsonAsync<JsonElement>("/api/models");
            var info = adminModels[0].GetProperty("liteLlmCapabilities");
            Assert.Equal("chat", info.GetProperty("mode").GetString());
            Assert.Contains("supports_function_calling", info.GetProperty("supportedFeatures").EnumerateArray()
                .Select(x => x.GetString()));
            Assert.Equal(128000, info.GetProperty("contextWindow").GetInt32());
            var initialCatalog = await client.GetFromJsonAsync<JsonElement>("/v1/models");
            Assert.Empty(initialCatalog.GetProperty("models").EnumerateArray());
            var denied = await client.PostAsJsonAsync("/v1/generate", new { model = model.Id, messages = Array.Empty<object>() });
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            db.UserModelGrants.Add(new UserModelGrant { UserId = userId, ModelId = model.Id });
            await db.SaveChangesAsync();
            var createdKey = await admin.PostAsJsonAsync("/api/virtual-keys", new { alias = "dsh-test", customKey = (string?)null });
            Assert.Equal(HttpStatusCode.OK, createdKey.StatusCode);
            using var keyBody = JsonDocument.Parse(await createdKey.Content.ReadAsStringAsync());
            var keyId = keyBody.RootElement.GetProperty("id").GetGuid();
            var grantKey = await admin.PutAsJsonAsync($"/api/virtual-keys/{keyId}/grants",
                new { userIds = new[] { userId }, departmentIds = Array.Empty<Guid>(), organizationIds = Array.Empty<Guid>() });
            Assert.Equal(HttpStatusCode.NoContent, grantKey.StatusCode);
            var grantAudits = await admin.GetFromJsonAsync<JsonElement>("/api/operation-audits");
            var grantAudit = grantAudits.GetProperty("items").EnumerateArray()
                .Single(x => x.GetProperty("action").GetString() == "virtual-key.grants");
            Assert.Equal("修改虚拟 Key 授权", grantAudit.GetProperty("actionLabel").GetString());
            Assert.Equal("虚拟 Key：dsh-test", grantAudit.GetProperty("entityLabel").GetString());
            Assert.Equal("用户：姚伟明", grantAudit.GetProperty("detailLabel").GetString());
            Assert.DoesNotContain(userId.ToString(), grantAudit.GetProperty("detailLabel").GetString());
            var grantedCatalog = await client.GetFromJsonAsync<JsonElement>("/v1/models");
            Assert.Single(grantedCatalog.GetProperty("models").EnumerateArray());
            Assert.Equal("model-1", grantedCatalog.GetProperty("models")[0].GetProperty("id").GetString());
            Assert.Equal("openai-completions", grantedCatalog.GetProperty("connection").GetProperty("api").GetString());
            Assert.Equal("http://litellm.example.test/v1", grantedCatalog.GetProperty("connection").GetProperty("baseURL").GetString());
            Assert.Equal("sk-user-test", grantedCatalog.GetProperty("connection").GetProperty("apiKey").GetString());
            var blocked = await admin.PutAsync($"/api/virtual-keys/{keyId}/enabled?enabled=false", null);
            Assert.Equal(HttpStatusCode.NoContent, blocked.StatusCode);
            Assert.Empty((await client.GetFromJsonAsync<JsonElement>("/v1/models"))
                .GetProperty("models").EnumerateArray());
            var unblocked = await admin.PutAsync($"/api/virtual-keys/{keyId}/enabled?enabled=true", null);
            Assert.Equal(HttpStatusCode.NoContent, unblocked.StatusCode);
            Assert.Equal(new[] { "text", "image" }, grantedCatalog.GetProperty("models")[0].GetProperty("input")
                .EnumerateArray().Select(x => x.GetString()));
            var generated = await client.PostAsJsonAsync("/v1/generate", new {
                model = model.Id, messages = new[] { new { role = "user", content = new[] { new { type = "text", text = "hello" } } } }
            });
            Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
            Assert.Contains("\"type\":\"finish\"", await generated.Content.ReadAsStringAsync());
            db.UserModelGrants.Remove(await db.UserModelGrants.SingleAsync());
            await db.SaveChangesAsync();
            var revoked = await client.PostAsJsonAsync("/v1/generate", new { model = model.Id, messages = Array.Empty<object>() });
            Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
            Assert.Equal(HttpStatusCode.NoContent, (await admin.DeleteAsync($"/api/models/{model.Id}")).StatusCode);
            var afterDelete = await admin.GetFromJsonAsync<JsonElement>("/api/operation-audits");
            var deletion = afterDelete.GetProperty("items").EnumerateArray()
                .Single(x => x.GetProperty("action").GetString() == "model.delete");
            Assert.Equal("模型：test-model", deletion.GetProperty("entityLabel").GetString());
            Assert.Contains("模型标识：model-1", deletion.GetProperty("detailLabel").GetString());
            Assert.DoesNotContain("ApiKey", deletion.GetProperty("detailJson").GetString());

            var bytes = "abcdef"u8.ToArray();
            var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var upload = await client.PostAsJsonAsync("/v1/uploads", new {
                userId, clientUploadId = "upload-1", sessionId = "session-1", eventSeq = 1,
                prompt = "summarize", deviceId = "device-1", computerName = "test-host",
                storedPath = @"C:\stored\report.txt", fileName = @"C:\secret\report.txt", bytes = bytes.Length, sha256 = hash
            });
            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
            var stored = await db.DshUploads.SingleAsync();
            Assert.Equal("report.txt", stored.FileName);
            Assert.True(stored.Completed);
            Assert.Equal("", stored.Sha256);
            Assert.Empty(Directory.GetFiles(root));
            // A historical completed upload remains downloadable after switching to metadata reporting.
            stored.Sha256 = hash;
            stored.Offset = bytes.Length;
            await db.SaveChangesAsync();
            await File.WriteAllBytesAsync(Path.Combine(root, $"{stored.Id:N}.bin"), bytes);
            client.DefaultRequestHeaders.Authorization = null;
            Assert.Equal(HttpStatusCode.Unauthorized,
                (await client.GetAsync($"/api/dsh-uploads/{stored.Id}/download")).StatusCode);
            var ordinaryLogin = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00412", password = "Bhss@123" });
            using var ordinaryBody = JsonDocument.Parse(await ordinaryLogin.Content.ReadAsStringAsync());
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                ordinaryBody.RootElement.GetProperty("accessToken").GetString());
            Assert.Equal(HttpStatusCode.Forbidden,
                (await client.GetAsync($"/api/dsh-uploads/{stored.Id}/download")).StatusCode);
            var adminLogin = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo = "wh00028", password = "Bhss@123" });
            using var adminBody = JsonDocument.Parse(await adminLogin.Content.ReadAsStringAsync());
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                adminBody.RootElement.GetProperty("accessToken").GetString());
            var list = await client.GetFromJsonAsync<JsonElement>("/api/dsh-uploads");
            Assert.Equal(1, list.GetProperty("total").GetInt32());
            Assert.Equal("Completed", Assert.Single(list.GetProperty("items").EnumerateArray()).GetProperty("status").GetString());
            var downloaded = await client.GetAsync($"/api/dsh-uploads/{stored.Id}/download");
            Assert.Equal(HttpStatusCode.OK, downloaded.StatusCode);
            Assert.Equal(bytes, await downloaded.Content.ReadAsByteArrayAsync());
            Assert.Contains("report.txt", downloaded.Content.Headers.ContentDisposition?.ToString());
            using var rangeRequest = new HttpRequestMessage(HttpMethod.Get, $"/api/dsh-uploads/{stored.Id}/download");
            rangeRequest.Headers.Range = new RangeHeaderValue(1, 3);
            var range = await client.SendAsync(rangeRequest);
            Assert.Equal(HttpStatusCode.PartialContent, range.StatusCode);
            Assert.Equal(bytes[1..4], await range.Content.ReadAsByteArrayAsync());

            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var largeBytes = new byte[4 * 1024 * 1024 + 1];
            RandomNumberGenerator.Fill(largeBytes);
            var largeHash = Convert.ToHexStringLower(SHA256.HashData(largeBytes));
            var largeUpload = await client.PostAsJsonAsync("/v1/uploads", new {
                userId, clientUploadId = "upload-large", sessionId = "session-1", eventSeq = 2,
                prompt = "large file", deviceId = "device-1", computerName = "test-host",
                storedPath = @"C:\stored\large.dat", fileName = "large.dat", bytes = largeBytes.Length, sha256 = largeHash
            });
            Assert.Equal(HttpStatusCode.OK, largeUpload.StatusCode);
            using var adminClient = factory.CreateClient();
            adminClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                adminBody.RootElement.GetProperty("accessToken").GetString());
            var largeRecord = await db.DshUploads.SingleAsync(x => x.ClientUploadId == "upload-large");
            Assert.True(largeRecord.Completed);
            Assert.Equal("", largeRecord.Sha256);
            Assert.Equal(HttpStatusCode.Conflict,
                (await adminClient.GetAsync($"/api/dsh-uploads/{largeRecord.Id}/download")).StatusCode);
            Assert.False(File.Exists(Path.Combine(root, $"{largeRecord.Id:N}.part")));
            Assert.False(File.Exists(Path.Combine(root, $"{largeRecord.Id:N}.bin")));
            var firstPage = await adminClient.GetFromJsonAsync<JsonElement>("/api/dsh-uploads?page=1&pageSize=1");
            var secondPage = await adminClient.GetFromJsonAsync<JsonElement>("/api/dsh-uploads?page=2&pageSize=1");
            Assert.Equal(2, firstPage.GetProperty("total").GetInt32());
            Assert.Single(firstPage.GetProperty("items").EnumerateArray());
            Assert.Single(secondPage.GetProperty("items").EnumerateArray());
            Assert.NotEqual(firstPage.GetProperty("items")[0].GetProperty("id").GetGuid(),
                secondPage.GetProperty("items")[0].GetProperty("id").GetGuid());
            var searched = await adminClient.GetFromJsonAsync<JsonElement>("/api/dsh-uploads?query=large.dat&status=Recorded");
            Assert.Equal(1, searched.GetProperty("total").GetInt32());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task GeneratePreservesRateLimitClassificationAndReturnsRequestId()
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-dsh-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root, () => new ReplyHandler(HttpStatusCode.TooManyRequests,
                "{\"error\":{\"message\":\"busy\"}}"));
            using var client = factory.CreateClient();
            var login = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            using var loginBody = JsonDocument.Parse(await login.Content.ReadAsStringAsync());
            var userId = loginBody.RootElement.GetProperty("user").GetProperty("id").GetGuid();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                loginBody.RootElement.GetProperty("access_token").GetString());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var model = new AiModelConfiguration { Name = "limited-model", BaseUrl = "https://model.example.test", ModelIdentifier = "model-1" };
            db.ModelConfigurations.Add(model);
            db.UserModelGrants.Add(new UserModelGrant { UserId = userId, Model = model });
            await db.SaveChangesAsync();

            var response = await client.PostAsJsonAsync("/v1/generate", new {
                model = model.Id, messages = new[] { new { role = "user", content = new[] { new { type = "text", text = "hello" } } } }
            });

            Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
            using var problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal("UPSTREAM_RATE_LIMIT", problem.RootElement.GetProperty("code").GetString());
            Assert.False(string.IsNullOrWhiteSpace(problem.RootElement.GetProperty("requestId").GetString()));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Theory]
    [InlineData("Auto", "unknown", false)]
    [InlineData("Supported", "supported", true)]
    [InlineData("Unsupported", "unsupported", false)]
    public async Task InternalModelsRequirePluginAndModelGrantsAndNeverRequireVirtualKeys(string imageMode, string state, bool supportsImages)
    {
        var root = Path.Combine(Path.GetTempPath(), $"aigc-internal-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new Factory(root);
            using var client = factory.CreateClient();
            const string path = "/v1/plugins/internal-model/models";
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(path)).StatusCode);
            var login = await client.PostAsJsonAsync("/v1/auth/login", new { username = "wh00028", password = "Bhss@123" });
            var body = await login.Content.ReadFromJsonAsync<JsonElement>();
            var userId = body.GetProperty("user").GetProperty("id").GetGuid();
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.GetProperty("access_token").GetString());
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var protection = scope.ServiceProvider.GetRequiredService<IDataProtectionProvider>();
            var local = new AiModelConfiguration { Name = "Internal MiniMax", ProviderKind = "Local", ImageInputMode = imageMode, Multiplier = "0.5×", BaseUrl = "https://internal.example/v1",
                EndpointPath = "/chat/completions", ModelIdentifier = "MiniMax", AuthType = "Bearer",
                ApiKeyProtected = protection.CreateProtector("AigcHub.ModelApiKeys.v1").Protect("test-internal-key") };
            var denied = new AiModelConfiguration { Name = "Denied", ProviderKind = "Local", BaseUrl = "https://internal.example/v1", ModelIdentifier = "denied" };
            var online = new AiModelConfiguration { Name = "Online", ProviderKind = "Online", BaseUrl = "https://online.example/v1", ModelIdentifier = "online" };
            db.ModelConfigurations.AddRange(local, denied, online);
            db.UserModelGrants.AddRange(new UserModelGrant { UserId = userId, Model = local }, new UserModelGrant { UserId = userId, Model = online });
            var plugin = new ManagedPlugin { PackageName = DshManagedEndpoints.InternalModelPackage, Name = "Internal", IsEnabled = true };
            var version = new ManagedPluginVersion { Plugin = plugin, Version = "1.0.0", DshVersion = "0.1.7-alpha.2" };
            plugin.PublishedVersionId = version.Id;
            db.ManagedPlugins.Add(plugin);
            db.ManagedPluginVersions.Add(version);
            await db.SaveChangesAsync();
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(path)).StatusCode);
            db.AccessGrants.Add(new AccessGrant { ResourceKey = PluginMarketEndpoints.Resource(plugin.Id), SubjectType = "User", SubjectId = userId });
            await db.SaveChangesAsync();
            var list = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.OK, list.StatusCode);
            Assert.True(list.Headers.CacheControl?.NoStore);
            var json = await list.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Single(json.GetProperty("models").EnumerateArray());
            Assert.Equal(local.Id.ToString("D"), json.GetProperty("models")[0].GetProperty("id").GetString());
            Assert.Equal("0.5×", json.GetProperty("models")[0].GetProperty("multiplier").GetString());
            Assert.Equal(state, json.GetProperty("models")[0].GetProperty("imageInput").GetProperty("state").GetString());
            Assert.Equal(supportsImages, json.GetProperty("models")[0].GetProperty("input").EnumerateArray().Any(x => x.GetString() == "image"));
            Assert.DoesNotContain("test-internal-key", json.ToString());
            var gateway = await client.GetFromJsonAsync<JsonElement>("/v1/models");
            Assert.Empty(gateway.GetProperty("models").EnumerateArray());
            Assert.Equal("managed-internal", gateway.GetProperty("additionalModels")[0].GetProperty("provider").GetString());
            Assert.DoesNotContain("test-internal-key", gateway.ToString());
            var connection = await client.GetAsync($"{path}/{local.Id}/connection");
            Assert.Equal(HttpStatusCode.OK, connection.StatusCode);
            Assert.True(connection.Headers.CacheControl?.NoStore);
            var route = await connection.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("test-internal-key", route.GetProperty("apiKey").GetString());
            Assert.Equal(state, route.GetProperty("imageInput").GetProperty("state").GetString());
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"{path}/{denied.Id}/connection")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"{path}/{online.Id}/connection")).StatusCode);
            db.UserModelGrants.Remove(await db.UserModelGrants.SingleAsync(x => x.ModelId == local.Id));
            await db.SaveChangesAsync();
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"{path}/{local.Id}/connection")).StatusCode);
            plugin.IsEnabled = false;
            await db.SaveChangesAsync();
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(path)).StatusCode);
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"{path}/{local.Id}/connection")).StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class Factory(string root, Func<HttpMessageHandler>? upstream = null,
        Func<HttpMessageHandler>? search = null) : WebApplicationFactory<Program>
    {
        private readonly string databaseName = $"dsh-{Guid.NewGuid():N}";

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("Cas:Enabled", "true");
            builder.UseSetting("Cas:ServiceUrl", "https://localhost/v1/auth/cas/callback");
            builder.UseSetting("DshUploads:Root", root);
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.UseSetting("LiteLlm:BaseUrl", "http://litellm.internal/v1");
            builder.UseSetting("LiteLlm:PublicBaseUrl", "http://litellm.example.test/v1");
            builder.UseSetting("LiteLlm:ApiKey", "sk-test-master");
            builder.UseSetting("LiteLlm:ManagementApiKey", "sk-test-master");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(databaseName));
                services.AddHttpClient("bhss-cas").ConfigurePrimaryHttpMessageHandler(() => new ReplyHandler(HttpStatusCode.OK,
                    "<serviceResponse><authenticationSuccess><user>wh00028</user><name>Test</name></authenticationSuccess></serviceResponse>"));
                services.AddHttpClient("dsh-managed-upstream")
                    .ConfigurePrimaryHttpMessageHandler(upstream ?? (() => new ReplyHandler()));
                services.AddHttpClient("dsh-managed-upstream-litellm")
                    .ConfigurePrimaryHttpMessageHandler(upstream ?? (() => new ReplyHandler()));
                services.AddHttpClient("litellm-key-management")
                    .ConfigurePrimaryHttpMessageHandler(() => new VirtualKeyHandler());
                services.AddHttpClient("deepseek-web-search")
                    .ConfigurePrimaryHttpMessageHandler(search ?? (() => new SearchReplyHandler()));
            });
        }
    }

    private sealed class SearchReplyHandler : HttpMessageHandler
    {
        public string? ApiKey { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            ApiKey = request.Headers.GetValues("x-api-key").Single();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{\"content\":[{\"type\":\"web_search_tool_result\",\"content\":[{\"type\":\"web_search_result\",\"url\":\"https://example.test\",\"title\":\"Example\"}]}]}")
            });
        }
    }

    private sealed class VirtualKeyHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(request.Method == HttpMethod.Get
                    ? "{\"data\":[{\"model_name\":\"model-1\",\"model_info\":{\"mode\":\"chat\",\"supports_vision\":true,\"supports_function_calling\":true,\"supports_audio_input\":false,\"max_input_tokens\":128000}}]}"
                    : "{\"key\":\"sk-user-test\",\"expires\":\"2099-01-01T00:00:00Z\"}")
            });
    }

    private sealed class ReplyHandler(HttpStatusCode status = HttpStatusCode.OK,
        string content = "{\"choices\":[{\"message\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}") : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(content)
            });
    }
}
