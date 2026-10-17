using System.Text.Json;
using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Tests;

public sealed class WorkflowServiceTests
{
    [Fact]
    public async Task Submit_creates_review_task_and_candidate_groups()
    {
        await using var db = CreateDb(); await SeedData.InitializeAsync(db);
        var actor = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync(); var service = CreateService(db);

        var request = await service.SubmitAsync(actor.Id, new SubmitPublicationRequest("设备知识助手", category.Id, "检索维修经验", "https://internal/apps/device"), default);

        var task = await db.WorkflowTasks.Include(x => x.Candidates).SingleAsync(x => x.InstanceId == request.ProcessInstanceId);
        Assert.Equal(PublicationStatus.Reviewing, request.Status);
        Assert.Contains(task.Candidates, x => x.Type == "role" && x.Value == "workflow-admin");
        Assert.Contains(task.Candidates, x => x.Type == "department" && x.Value == "digital");
    }

    [Fact]
    public async Task Approval_waits_for_callback_and_callback_is_idempotent()
    {
        await using var db = CreateDb(); await SeedData.InitializeAsync(db);
        var applicant = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var reviewer = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00136");
        var category = await db.Categories.FirstAsync(); var service = CreateService(db);
        var request = await service.SubmitAsync(applicant.Id, new SubmitPublicationRequest("质量助手", category.Id, "质量案例", "https://internal/apps/quality"), default);
        var task = await db.WorkflowTasks.SingleAsync(x => x.InstanceId == request.ProcessInstanceId);

        await service.CompleteTaskAsync(reviewer.Id, task.Id, new CompleteTaskRequest("approve", "代码审核通过", null), default);
        var deployReviewer = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var deployTask = await db.WorkflowTasks.SingleAsync(x => x.InstanceId == request.ProcessInstanceId && x.Status == WorkflowTaskStatus.Pending);
        var completion = await service.CompleteTaskAsync(deployReviewer.Id, deployTask.Id, new CompleteTaskRequest("approve", "批准部署", null), default);
        var subscription = await db.CallbackSubscriptions.SingleAsync(x => x.InstanceId == request.ProcessInstanceId);
        Assert.Contains("correlationId", JsonSerializer.Serialize(completion));
        Assert.Equal(PublicationStatus.Publishing, request.Status);

        var callback = new CallbackRequest("evt-001", subscription.CorrelationId, "Succeeded", JsonDocument.Parse("{\"deploymentUrl\":\"https://published.example.com\"}").RootElement);
        var first = await service.ReceiveCallbackAsync(callback, default);
        var duplicate = await service.ReceiveCallbackAsync(callback, default);
        Assert.False(first.Duplicate); Assert.True(duplicate.Duplicate);
        Assert.Equal(PublicationStatus.Approved, request.Status);
        Assert.Equal("https://published.example.com", request.AccessUrl);
        Assert.Single(await db.CallbackInbox.ToListAsync());
    }

    [Fact]
    public async Task Unassigned_user_cannot_complete_review()
    {
        await using var db = CreateDb(); await SeedData.InitializeAsync(db);
        var applicant = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var category = await db.Categories.FirstAsync(); var service = CreateService(db);
        var request = await service.SubmitAsync(applicant.Id, new SubmitPublicationRequest("研发助手", category.Id, "说明", "https://internal/apps/rd"), default);
        var task = await db.WorkflowTasks.SingleAsync(x => x.InstanceId == request.ProcessInstanceId);

        var exception = await Assert.ThrowsAsync<WorkflowException>(() => service.CompleteTaskAsync(applicant.Id, task.Id, new CompleteTaskRequest("approve", null, null), default));
        Assert.Equal(403, exception.StatusCode);
    }

    [Fact]
    public async Task Published_definition_controls_candidate_role_and_blocks_self_approval()
    {
        await using var db = CreateDb(); await SeedData.InitializeAsync(db);
        var oldDefinition = await db.ProcessDefinitions.SingleAsync(x => x.IsPublished);
        oldDefinition.IsPublished = false;
        db.ProcessDefinitions.Add(new ProcessDefinition
        {
            Key = "application-publishing", Name = "平台管理员审批", Version = 2, IsPublished = true,
            DefinitionJson = """{"nodes":[{"id":"review","type":"userTask","name":"平台管理员审核","assignmentType":"role","assignee":"platform-admin"}]}"""
        });
        await db.SaveChangesAsync();
        var platformAdmin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var category = await db.Categories.FirstAsync();
        var service = CreateService(db);

        var request = await service.SubmitAsync(platformAdmin.Id,
            new SubmitPublicationRequest("自审测试", category.Id, "验证职责分离", "https://internal/apps/self-review"), default);
        var task = await db.WorkflowTasks.Include(x => x.Candidates).SingleAsync(x => x.InstanceId == request.ProcessInstanceId);

        Assert.Contains(task.Candidates, x => x.Type == "role" && x.Value == "platform-admin");
        var exception = await Assert.ThrowsAsync<WorkflowException>(() => service.CompleteTaskAsync(platformAdmin.Id,
            task.Id, new CompleteTaskRequest("approve", null, null), default));
        Assert.Equal(403, exception.StatusCode);
        Assert.Contains("不能审核自己", exception.Message);
    }

    private static AigcHubDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        return new AigcHubDbContext(options);
    }

    private static WorkflowService CreateService(AigcHubDbContext db) =>
        new(db, new FakePublisher(), new WorkflowDefinitionReader(db));

    private sealed class FakePublisher : IRealtimeNotificationPublisher
    {
        public Task PublishAsync(Guid userId, string title, string content, string link, CancellationToken ct) => Task.CompletedTask;
    }
}
