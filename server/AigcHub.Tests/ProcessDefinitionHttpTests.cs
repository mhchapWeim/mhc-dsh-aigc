using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class ProcessDefinitionHttpTests
{
    private static object Definition(string name = "测试流程") => new {
        name,
        nodes = new[] {
            new { id = "start", name = "开始", type = "start", x = 50, y = 100 },
            new { id = "end", name = "结束", type = "end", x = 300, y = 100 }
        },
        edges = new[] { new { id = "edge", source = "start", target = "end" } }
    };
    private static async Task<JsonElement> Create(HttpClient client, string key, object? definition = null)
    {
        var response = await client.PostAsJsonAsync("/api/process-definitions", new {
            key, name = "测试流程", version = 0, definition = definition ?? Definition(), isPublished = false
        });
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    [Fact]
    public async Task Saves_the_same_draft_and_rejects_stale_edits()
    {
        using var factory = new Factory();
        using var client = await Login(factory, "wh00028");
        var draft = await Create(client, "draft-test");
        var id = draft.GetProperty("id").GetGuid();
        var input = new { name = "已修改", definition = Definition("已修改"), expectedUpdatedAt = draft.GetProperty("updatedAt").GetString() };
        var saved = await client.PutAsJsonAsync($"/api/process-definitions/{id}", input);
        saved.EnsureSuccessStatusCode();
        var updated = await saved.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(1, updated.GetProperty("version").GetInt32());
        Assert.Equal(id, updated.GetProperty("id").GetGuid());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PutAsJsonAsync($"/api/process-definitions/{id}", input)).StatusCode);
        var all = await client.GetFromJsonAsync<JsonElement>("/api/process-definitions");
        Assert.Single(all.EnumerateArray(), x => x.GetProperty("key").GetString() == "draft-test");
    }

    [Fact]
    public async Task Versions_are_per_process_and_published_history_remains_immutable_after_replacement_or_disable()
    {
        using var factory = new Factory();
        using var client = await Login(factory, "wh00028");
        var first = await Create(client, "version-test"); var firstId = first.GetProperty("id").GetGuid();
        (await client.PostAsync($"/api/process-definitions/{firstId}/publish", null)).EnsureSuccessStatusCode();
        var second = await Create(client, "version-test"); var secondId = second.GetProperty("id").GetGuid();
        Assert.Equal(2, second.GetProperty("version").GetInt32());
        Assert.Equal(1, (await Create(client, "another-process")).GetProperty("version").GetInt32());
        (await client.PostAsync($"/api/process-definitions/{secondId}/publish", null)).EnsureSuccessStatusCode();
        var all = await client.GetFromJsonAsync<JsonElement>("/api/process-definitions");
        var siblings = all.EnumerateArray().Where(x => x.GetProperty("key").GetString() == "version-test").ToArray();
        Assert.Single(siblings, x => x.GetProperty("isPublished").GetBoolean());
        Assert.Equal(secondId, siblings.Single(x => x.GetProperty("isPublished").GetBoolean()).GetProperty("id").GetGuid());
        Assert.All(siblings, item => Assert.Equal(JsonValueKind.String, item.GetProperty("publishedAt").ValueKind));
        foreach (var item in siblings)
        {
            var response = await client.PutAsJsonAsync($"/api/process-definitions/{item.GetProperty("id").GetGuid()}", new { name = "篡改", definition = Definition(), expectedUpdatedAt = item.GetProperty("updatedAt").GetString() });
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        }
        (await client.PostAsync($"/api/process-definitions/{secondId}/disable", null)).EnsureSuccessStatusCode();
        var disabled = (await client.GetFromJsonAsync<JsonElement>("/api/process-definitions")).EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == secondId);
        Assert.False(disabled.GetProperty("isPublished").GetBoolean());
        Assert.Equal(JsonValueKind.String, disabled.GetProperty("publishedAt").ValueKind);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PutAsJsonAsync($"/api/process-definitions/{secondId}", new { name = "篡改", definition = Definition(), expectedUpdatedAt = disabled.GetProperty("updatedAt").GetString() })).StatusCode);
    }

    [Fact]
    public async Task Invalid_definitions_cannot_be_published_and_endpoints_require_process_permission()
    {
        using var factory = new Factory();
        using var client = await Login(factory, "wh00028");
        var draft = await Create(client, "empty-process", new { name = "空流程", nodes = Array.Empty<object>(), edges = Array.Empty<object>() });
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync($"/api/process-definitions/{draft.GetProperty("id").GetGuid()}/publish", null)).StatusCode);
        var invalid = await client.PostAsJsonAsync("/api/process-definitions", new { key = "Bad Key", name = "测试", version = 0, definition = Definition(), isPublished = false });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/process-definitions")).StatusCode);
        using var applicant = await Login(factory, "wh00412");
        Assert.Equal(HttpStatusCode.Forbidden, (await applicant.PostAsync($"/api/process-definitions/{draft.GetProperty("id").GetGuid()}/publish", null)).StatusCode);
    }

    private static async Task<HttpClient> Login(Factory factory, string employeeNo)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("accessToken").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string database = "process-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services => {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
