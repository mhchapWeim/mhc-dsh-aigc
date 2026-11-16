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

/// <summary>
/// A reviewer could only see an application name and a summary, so the review decision
/// had to be made blind. These tests pin the details the inbox has to carry.
/// </summary>
public sealed class PublicationDetailHttpTests
{
    [Fact]
    public async Task Reviewer_sees_every_submitted_field_and_the_inbox_message()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var reviewer = await Login(factory, "wh00136");

        var categoryId = await FirstCategoryIdAsync(applicant);
        var submitted = await applicant.PostAsJsonAsync("/api/publication-requests", new
        {
            appName = "设备知识助手", categoryId, summary = "检索设备知识与维修经验",
            repositoryUrl = "https://git.example.com/aigc/device-agent", branch = "release/1.2.0",
            commitSha = "abcdef1234567890abcdef1234567890abcdef12", version = "1.2.0",
            environment = "Production", accessMode = "All"
        });
        submitted.EnsureSuccessStatusCode();
        var requestId = (await submitted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        var reviewable = await reviewer.GetFromJsonAsync<JsonElement>("/api/publication-requests/reviewable?page=1&pageSize=100");
        var item = reviewable.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == requestId);
        Assert.Equal("https://git.example.com/aigc/device-agent", item.GetProperty("repositoryUrl").GetString());
        Assert.Equal("release/1.2.0", item.GetProperty("branch").GetString());
        Assert.Equal("abcdef1234567890abcdef1234567890abcdef12", item.GetProperty("commitSha").GetString());
        Assert.Equal("1.2.0", item.GetProperty("version").GetString());
        Assert.Equal("Production", item.GetProperty("environment").GetString());
        Assert.Equal("所有已登录用户", item.GetProperty("accessScope").GetString());
        Assert.Equal("PUB", item.GetProperty("requestNo").GetString()![..3]);
        Assert.Equal(JsonValueKind.String, item.GetProperty("taskId").ValueKind);
        // A pending task must never be reported as finished; the scope comes from the task itself.
        Assert.Equal("候选用户组", item.GetProperty("candidateScope").GetString());

        // The notification must be addressed to the candidate reviewer, not to the applicant.
        var inbox = await reviewer.GetFromJsonAsync<JsonElement>("/api/notifications/mine?page=1&pageSize=20");
        Assert.Equal(1, inbox.GetProperty("unreadCount").GetInt32());
        var message = inbox.GetProperty("items").EnumerateArray().Single();
        Assert.Contains("设备知识助手", message.GetProperty("title").GetString());
        Assert.Equal("/admin/reviews", message.GetProperty("link").GetString());
        Assert.False(message.GetProperty("isRead").GetBoolean());

        var unread = await reviewer.GetFromJsonAsync<JsonElement>("/api/notifications/unread");
        Assert.Equal(1, unread.GetProperty("unread").GetInt32());

        var applicantInbox = await applicant.GetFromJsonAsync<JsonElement>("/api/notifications/mine?page=1&pageSize=20");
        Assert.Equal(0, applicantInbox.GetProperty("total").GetInt32());
    }

    [Fact]
    public async Task Notifications_can_be_read_one_by_one_or_all_at_once()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var reviewer = await Login(factory, "wh00136");
        var categoryId = await FirstCategoryIdAsync(applicant);

        foreach (var name in new[] { "应用一", "应用二" })
            (await applicant.PostAsJsonAsync("/api/publication-requests", new
            {
                appName = name, categoryId, summary = "说明", repositoryUrl = "https://git.example.com/a/b",
                branch = "main", commitSha = "abcdef1234567890", version = "1.0.0", accessMode = "All"
            })).EnsureSuccessStatusCode();

        var messages = await reviewer.GetFromJsonAsync<JsonElement>("/api/notifications/mine?page=1&pageSize=20");
        Assert.Equal(2, messages.GetProperty("unreadCount").GetInt32());
        var first = messages.GetProperty("items")[0].GetProperty("id").GetGuid();
        (await reviewer.PostAsync($"/api/notifications/{first}/read", null)).EnsureSuccessStatusCode();
        Assert.Equal(1, (await reviewer.GetFromJsonAsync<JsonElement>("/api/notifications/unread")).GetProperty("unread").GetInt32());

        (await reviewer.PostAsync("/api/notifications/read-all", null)).EnsureSuccessStatusCode();
        Assert.Equal(0, (await reviewer.GetFromJsonAsync<JsonElement>("/api/notifications/unread")).GetProperty("unread").GetInt32());
    }

    private static async Task<Guid> FirstCategoryIdAsync(HttpClient client)
    {
        var options = await client.GetFromJsonAsync<JsonElement>("/api/publication-requests/options");
        return options.EnumerateArray().First().GetProperty("id").GetGuid();
    }

    /// <summary>
    /// The reviewer must receive the third-party audit verdict so they can open the report
    /// link and decide. The result arrives through the service callback and is stored under
    /// variables.nodes[nodeKey].
    /// </summary>
    [Fact]
    public async Task Reviewer_receives_the_audit_verdict_and_report_link()
    {
        using var factory = new Factory();
        using var applicant = await Login(factory, "wh00412");
        using var reviewer = await Login(factory, "wh00136");

        var categoryId = await FirstCategoryIdAsync(applicant);
        var submitted = await applicant.PostAsJsonAsync("/api/publication-requests", new
        {
            appName = "审计详情应用", categoryId, summary = "验证审计详情回传",
            repositoryUrl = "https://git.example.com/aigc/audit-demo", branch = "main",
            commitSha = "abcdef1234567890abcdef1234567890abcdef12", version = "1.0.0",
            environment = "Test", accessMode = "All"
        });
        submitted.EnsureSuccessStatusCode();
        var requestId = (await submitted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        // Simulate the service callback payload the runner persists for the audited node.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var request = await db.PublicationRequests.SingleAsync(x => x.Id == requestId);
            var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == request.ProcessInstanceId);
            instance.VariablesJson = """
                {"codeSource":{},"nodes":{"code_audit":{"decision":"Passed",
                "summary":"未发现阻断问题","detailUrl":"https://audit.example.com/reports/42",
                "commitSha":"abcdef1234567890abcdef1234567890abcdef12","issues":[],"executionStatus":"Succeeded"}}}
                """;
            await db.SaveChangesAsync();
        }

        var reviewable = await reviewer.GetFromJsonAsync<JsonElement>("/api/publication-requests/reviewable?page=1&pageSize=100");
        var item = reviewable.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == requestId);
        var audit = item.GetProperty("audit");
        Assert.Equal("Passed", audit.GetProperty("decision").GetString());
        Assert.Equal("https://audit.example.com/reports/42", audit.GetProperty("detailUrl").GetString());
        Assert.Equal("未发现阻断问题", audit.GetProperty("summary").GetString());
        Assert.Equal("0", audit.GetProperty("issueCount").GetString());

        // The dedicated snake_case adapter normalizes the provider's richer verdict
        // without confusing a completed review with an execution failure.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var request = await db.PublicationRequests.SingleAsync(x => x.Id == requestId);
            var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == request.ProcessInstanceId);
            instance.VariablesJson = """
                {"nodes":{"code_audit":{"protocol":"code-review-20261112","decision":"Warning",
                "verdict":"Warning","riskLevel":"High","taskId":"56d960a3-973b-4721-8b83-13f2850f1ca2",
                "reportUrl":"https://review.example.com/reviews/42","finishedAt":"2026-11-12T08:30:00Z",
                "repositoryFullName":"aigc/audit-demo","reviewerSubject":"wh00412","executionStatus":"Completed"}}}
                """;
            await db.SaveChangesAsync();
        }
        var updated = await reviewer.GetFromJsonAsync<JsonElement>("/api/publication-requests/reviewable?page=1&pageSize=100");
        var normalized = updated.GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == requestId).GetProperty("audit");
        Assert.Equal("Warning", normalized.GetProperty("verdict").GetString());
        Assert.Equal("High", normalized.GetProperty("riskLevel").GetString());
        Assert.Equal("Completed", normalized.GetProperty("executionStatus").GetString());
        Assert.Equal("https://review.example.com/reviews/42", normalized.GetProperty("detailUrl").GetString());
        Assert.Equal("wh00412", normalized.GetProperty("reviewerSubject").GetString());
        Assert.Equal("56d960a3-973b-4721-8b83-13f2850f1ca2", normalized.GetProperty("taskId").GetString());
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
        private readonly string database = "publication-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services =>
        {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
            services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
