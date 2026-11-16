using System.Text.Json;
using System.Text.Json.Nodes;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Tests;

public sealed class IntegrationWorkflowTests
{
    private const string Definition = """
    {"executionMode":"integrated-v1","nodes":[
      {"id":"start","type":"start","name":"开始"},
      {"id":"audit","type":"serviceTask","name":"代码审计","serviceCode":"code-audit","operationCode":"audit.submit.v1","timeoutSeconds":3600,"verifyCommit":true},
      {"id":"review","type":"userTask","name":"部署审批","assignmentType":"role","assignee":"platform-admin"},
      {"id":"deploy","type":"serviceTask","name":"部署","serviceCode":"code-audit","operationCode":"deploy.submit.v1","timeoutSeconds":3600,"verifyCommit":true,"deploymentUrlField":"deploymentUrl"},
      {"id":"end","type":"end","name":"完成","result":"Approved"},
      {"id":"reject","type":"end","name":"退回","result":"Rejected"},
      {"id":"failed","type":"end","name":"失败","result":"Failed"}],
     "edges":[{"source":"start","target":"audit"},
       {"source":"audit","target":"review","outcome":"passed"},{"source":"audit","target":"reject","outcome":"rejected"},{"source":"audit","target":"failed"},
       {"source":"review","target":"deploy","outcome":"passed"},{"source":"review","target":"reject"},
       {"source":"deploy","target":"end","outcome":"succeeded"},{"source":"deploy","target":"failed"}]}
    """;

    [Fact]
    public async Task Audit_result_resumes_graph_once_and_deployment_finishes_with_fixed_commit()
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        Assert.Null(IntegrationDefinitionValidator.Validate(JsonNode.Parse(Definition)!));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        Assert.Empty(await db.WorkflowTasks.ToListAsync());
        var call = await db.IntegrationInvocations.SingleAsync();
        using var payload = JsonDocument.Parse(call.Payload);
        Assert.Equal(request.CommitSha, payload.RootElement.GetProperty("data").GetProperty("commitSha").GetString());
        Assert.Equal(WorkflowInstanceStatus.WaitingCallback, instance.Status);
        var result = Result(call, "audit-1", "Succeeded", new { decision = "Passed", commitSha = request.CommitSha });
        Assert.False(await runner.ReceiveAsync("code-audit", result, default));
        Assert.True(await runner.ReceiveAsync("code-audit", result, default));
        Assert.True(await runner.ReceiveAsync("code-audit", result with { MessageId = "another-result" }, default));
        Assert.Single(await db.WorkflowTasks.ToListAsync());
        Assert.Equal("review", instance.CurrentNodeKey);
        await runner.AdvanceAsync(definition, instance, request, "review", "passed", default); await db.SaveChangesAsync();
        var deployment = await db.IntegrationInvocations.SingleAsync(x => x.NodeKey == "deploy");
        await runner.ReceiveAsync("code-audit", Result(deployment, "deploy-1", "Succeeded", new { decision = "Passed", commitSha = request.CommitSha, deploymentUrl = "https://apps.example.com/app" }), default);
        Assert.Equal(PublicationStatus.Approved, request.Status);
        Assert.Equal("https://apps.example.com/app", request.AccessUrl);
        Assert.Equal("Stale", (await db.IntegrationReceipts.SingleAsync(x => x.MessageId == "another-result")).Disposition);
    }

    [Theory]
    [InlineData("Succeeded", "Passed", PublicationStatus.Reviewing)]
    [InlineData("Succeeded", "Rejected", PublicationStatus.Rejected)]
    [InlineData("Failed", "", PublicationStatus.Failed)]
    public async Task Business_rejection_is_distinct_from_service_failure(string execution, string decision, PublicationStatus expected)
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        var call = await db.IntegrationInvocations.SingleAsync();
        await runner.ReceiveAsync("code-audit", Result(call, "result-1", execution, new { decision, commitSha = request.CommitSha }), default);
        Assert.Equal(expected, request.Status);
        if (expected == PublicationStatus.Reviewing) Assert.Single(await db.WorkflowTasks.ToListAsync());
        else Assert.Empty(await db.WorkflowTasks.ToListAsync());
    }

    [Fact]
    public async Task Wrong_source_wrong_commit_and_progress_cannot_advance()
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        var call = await db.IntegrationInvocations.SingleAsync();
        var result = Result(call, "result-1", "Succeeded", new { decision = "Passed", commitSha = "wrong" });
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveAsync("other-service", result, default));
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveAsync("code-audit", result, default));
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveAsync("code-audit", result with { ExecutionStatus = "Running" }, default));
        Assert.Empty(await db.IntegrationReceipts.ToListAsync());
        Assert.Equal("audit", instance.CurrentNodeKey);
    }

    [Fact]
    public async Task Expired_result_and_result_after_cancellation_are_recorded_without_advancing()
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        var call = await db.IntegrationInvocations.SingleAsync(); call.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1); await db.SaveChangesAsync();
        Assert.True(await runner.ReceiveAsync("code-audit", Result(call, "late", "Succeeded", new { decision = "Passed", commitSha = request.CommitSha }), default));
        Assert.Equal("Expired", (await db.IntegrationReceipts.SingleAsync()).Disposition);
        instance.Status = WorkflowInstanceStatus.Rejected; await db.SaveChangesAsync();
        Assert.True(await runner.ReceiveAsync("code-audit", Result(call, "cancelled", "Succeeded", new { decision = "Passed", commitSha = request.CommitSha }), default));
        Assert.Empty(await db.WorkflowTasks.ToListAsync());
    }

    [Fact]
    public void Definition_rejects_automatic_cycles_and_invalid_mapping()
    {
        var doc = JsonNode.Parse(Definition)!;
        doc["nodes"]![1]!["inputMappings"] = new JsonObject { ["secret"] = "config.password" };
        Assert.NotNull(IntegrationDefinitionValidator.Validate(doc));
    }

    [Fact]
    public async Task Missing_audit_verdict_is_rejected_without_saving_receipt()
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        var call = await db.IntegrationInvocations.SingleAsync();
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveAsync("code-audit", Result(call, "missing", "Succeeded", new { commitSha = request.CommitSha }), default));
        Assert.Empty(await db.IntegrationReceipts.ToListAsync());
    }

    [Fact]
    public async Task Explicit_empty_input_mapping_sends_no_business_fields()
    {
        await using var db = CreateDb(); var (definition, instance, request) = await Seed(db);
        var doc = JsonNode.Parse(definition.DefinitionJson)!; doc["nodes"]![1]!["inputMappings"] = new JsonObject(); definition.DefinitionJson = doc.ToJsonString();
        await new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db)).AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        var payload = JsonNode.Parse((await db.IntegrationInvocations.SingleAsync()).Payload)!;
        Assert.Empty(payload["data"]!.AsObject());
    }

    [Fact]
    public async Task Configured_service_cannot_be_silently_skipped_in_legacy_mode()
    {
        await using var db = CreateDb(); var (definition, instance, _) = await Seed(db);
        var doc = JsonNode.Parse(definition.DefinitionJson)!; doc.AsObject().Remove("executionMode"); definition.DefinitionJson = doc.ToJsonString();
        Assert.NotNull(IntegrationDefinitionValidator.Validate(doc));
        await Assert.ThrowsAsync<WorkflowException>(() => new WorkflowDefinitionReader(db).CreateFirstUserTaskAsync(definition, instance.Id, instance.InitiatorId, default));
    }

    private static IntegrationResult Result(IntegrationInvocation call, string messageId, string execution, object data) =>
        new(messageId, call.ServiceCode, call.ResultEvent, call.Id, execution, JsonSerializer.SerializeToElement(data));
    private static AigcHubDbContext CreateDb() => new(new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
    private static async Task<(ProcessDefinition, WorkflowInstance, PublicationRequest)> Seed(AigcHubDbContext db)
    {
        await SeedData.InitializeAsync(db);
        db.IntegrationServices.Add(new IntegrationService { Code = "code-audit", Name = "代码审计", Kind = "Mq", IsEnabled = true, ConnectionKey = "Audit",
            OperationsJson = """[{"code":"audit.submit.v1","resultEvent":"audit.completed.v1"},{"code":"deploy.submit.v1","resultEvent":"deploy.completed.v1"}]""" });
        var definition = new ProcessDefinition { Key = "integrated-test", Name = "测试", DefinitionJson = Definition, IsPublished = true };
        var request = new PublicationRequest { AppName = "应用", RequestNo = "test", Summary = "说明", CommitSha = new string('a', 40), RepositoryUrl = "https://git.example.com/team/app", CategoryId = (await db.Categories.FirstAsync()).Id, ApplicantId = (await db.Users.FirstAsync()).Id };
        var instance = new WorkflowInstance { ProcessDefinitionId = definition.Id, BusinessId = request.Id, BusinessType = "application-publication", InitiatorId = request.ApplicantId };
        request.ProcessInstanceId = instance.Id;
        db.AddRange(definition, request, instance); await db.SaveChangesAsync();
        return (definition, instance, request);
    }
}
