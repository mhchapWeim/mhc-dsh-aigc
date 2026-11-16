using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Tests;

public sealed class CodeReviewProtocolTests
{
    [Fact]
    public async Task Request_uses_exact_wire_shape_authenticated_applicant_and_frozen_repository()
    {
        await using var db = Db(); var (runner, call, _, request) = await Start(db);
        var body = JsonNode.Parse(call.Payload)!.AsObject();
        Assert.Equal(CodeReviewProtocol.Name, call.Protocol);
        Assert.Equal(10, body.Count);
        Assert.Null(body["schema_version"]); Assert.Null(body["data"]); Assert.Null(body["serviceCode"]);
        Assert.Equal("review.requested", body["event_type"]!.ToString());
        Assert.Equal(call.Id.ToString(), body["message_id"]!.ToString());
        Assert.Equal(call.Id.ToString(), body["request_id"]!.ToString());
        Assert.Equal(call.InstanceId.ToString(), body["workflow_id"]!.ToString());
        Assert.Equal((await db.Users.SingleAsync(u => u.Id == request.ApplicantId)).EmployeeNo, body["reviewer_subject"]!.ToString());
        Assert.Equal("team/app", body["repository"]!["full_name"]!.ToString());
        Assert.Equal(request.CommitSha, body["repository"]!["commit_sha"]!.ToString());
        Assert.True(CodeReviewProtocol.Time(body["produced_at"]!.ToString(), "produced_at") < CodeReviewProtocol.Time(body["deadline_at"]!.ToString(), "deadline_at"));
        var original = call.Payload; call.Attempts++; call.NextAttemptAt = DateTimeOffset.UtcNow.AddMinutes(5); await db.SaveChangesAsync();
        Assert.Equal(original, call.Payload);
        Assert.NotNull(runner);
    }

    [Theory]
    [InlineData("Completed", "Passed", "passed")]
    [InlineData("Completed", "Failed", "rejected")]
    [InlineData("Completed", "Warning", "needs-review")]
    [InlineData("Completed", "Needs Review", "needs-review")]
    [InlineData("Failed", null, "failed")]
    [InlineData("Cancelled", null, "cancelled")]
    [InlineData("Rejected", null, "request-rejected")]
    public async Task Every_terminal_state_is_parsed_persisted_and_routed(string status, string? verdict, string outcome)
    {
        await using var db = Db(); var (runner, call, instance, _) = await Start(db);
        var result = Result(call, status, verdict);
        var parsed = Parse(result);
        Assert.Equal(outcome, CodeReviewProtocol.Outcome(parsed));
        Assert.False(await runner.ReceiveMessageAsync("code-audit", JsonSerializer.SerializeToUtf8Bytes(result, CodeReviewProtocol.JsonOptions), Properties(result), default));
        Assert.True(await runner.ReceiveMessageAsync("code-audit", JsonSerializer.SerializeToUtf8Bytes(result, CodeReviewProtocol.JsonOptions), Properties(result), default));
        Assert.Equal(status == "Completed" && verdict == "Passed" ? "approval" : outcome == "needs-review" ? "manual" : "failed", instance.CurrentNodeKey);
        Assert.Equal("Completed", call.Status);
        Assert.Single(await db.IntegrationReceipts.ToListAsync());
        Assert.Contains("event_id", call.ResultJson);
        if (status == "Completed")
        {
            var output = JsonNode.Parse(instance.VariablesJson)!["nodes"]!["audit"]!;
            Assert.Equal(verdict, output["verdict"]!.ToString());
            Assert.Equal("High", output["riskLevel"]!.ToString());
        }
    }

    [Fact]
    public async Task Request_conflict_does_not_consume_original_call_and_later_result_can_complete_it()
    {
        await using var db = Db(); var (runner, call, instance, _) = await Start(db);
        var conflict = Result(call, "Rejected", null) with { Error = new ReviewError("REQUEST_CONFLICT", "请求内容冲突", false, []) };
        Assert.True(await runner.ReceiveReviewAsync("code-audit", Parse(conflict), default));
        Assert.Equal("Pending", call.Status); Assert.Equal("audit", instance.CurrentNodeKey);
        Assert.Equal("RequestConflict", (await db.IntegrationReceipts.SingleAsync()).Disposition);
        Assert.False(await runner.ReceiveReviewAsync("code-audit", Parse(Result(call, "Completed", "Passed")), default));
        Assert.Equal("approval", instance.CurrentNodeKey);
    }

    [Theory]
    [InlineData("request_message_id")]
    [InlineData("workflow_id")]
    [InlineData("reviewer_subject")]
    [InlineData("repository")]
    public async Task Mismatched_binding_cannot_advance(string field)
    {
        await using var db = Db(); var (runner, call, instance, _) = await Start(db);
        var result = Result(call, "Completed", "Passed");
        result = field switch {
            "request_message_id" => result with { RequestMessageId = Guid.NewGuid().ToString() },
            "workflow_id" => result with { WorkflowId = Guid.NewGuid().ToString() },
            "reviewer_subject" => result with { ReviewerSubject = "someone-else" },
            _ => result with { Repository = new ReviewRepository("other/app", new string('b', 40)) }
        };
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveReviewAsync("code-audit", Parse(result), default));
        Assert.Empty(await db.IntegrationReceipts.ToListAsync()); Assert.Equal("audit", instance.CurrentNodeKey);
    }

    [Fact]
    public async Task Expired_and_old_call_results_do_not_create_new_tasks()
    {
        await using var db = Db(); var (runner, call, instance, _) = await Start(db);
        call.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1); await db.SaveChangesAsync();
        Assert.True(await runner.ReceiveReviewAsync("code-audit", Parse(Result(call, "Completed", "Passed")), default));
        Assert.Equal("Expired", (await db.IntegrationReceipts.SingleAsync()).Disposition);
        Assert.Equal("audit", instance.CurrentNodeKey); Assert.Empty(await db.WorkflowTasks.ToListAsync());
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("missing")]
    [InlineData("nested-unknown")]
    [InlineData("no-timezone")]
    [InlineData("bad-null")]
    [InlineData("bad-event")]
    [InlineData("bad-verdict")]
    [InlineData("whitespace")]
    [InlineData("duplicate")]
    [InlineData("large")]
    [InlineData("amqp")]
    public async Task Invalid_contract_is_rejected(string invalid)
    {
        await using var db = Db(); var (_, call, _, _) = await Start(db);
        var result = Result(call, "Completed", "Passed");
        var body = JsonSerializer.SerializeToNode(result, CodeReviewProtocol.JsonOptions)!.AsObject();
        switch (invalid)
        {
            case "unknown": body["schema_version"] = "1.0"; break;
            case "missing": body.Remove("workflow_id"); break;
            case "nested-unknown": body["repository"]!["token"] = "forbidden"; break;
            case "no-timezone": body["finished_at"] = "2026-11-12T08:30:00"; break;
            case "bad-null": body["task_id"] = null; break;
            case "bad-event": body["event_type"] = "review.rejected"; break;
            case "bad-verdict": body["verdict"] = "Succeeded"; break;
            case "whitespace": body["reviewer_subject"] = " applicant "; break;
        }
        var text = body.ToJsonString();
        if (invalid == "duplicate") text = text.Insert(1, "\"status\":\"Completed\",");
        if (invalid == "large") text += new string(' ', CodeReviewProtocol.MaxBytes);
        var properties = Properties(result);
        if (invalid == "amqp") properties = properties with { CorrelationId = "wrong" };
        Assert.Throws<WorkflowException>(() => CodeReviewProtocol.Parse(Encoding.UTF8.GetBytes(text), properties));
    }

    [Fact]
    public async Task Generic_protocol_cannot_bypass_review_checks_and_warning_requires_manual_path()
    {
        await using var db = Db(); var (runner, call, _, _) = await Start(db);
        await Assert.ThrowsAsync<WorkflowException>(() => runner.ReceiveAsync("code-audit", new IntegrationResult("generic", "code-audit", "review.finished", call.Id, "Succeeded", JsonSerializer.SerializeToElement(new { decision = "Passed" })), default));
        var definition = await db.ProcessDefinitions.SingleAsync(d => d.Key == "review-contract-test");
        var doc = JsonNode.Parse(definition.DefinitionJson)!;
        doc["edges"]!.AsArray().RemoveAt(2);
        Assert.NotNull(IntegrationDefinitionValidator.Validate(doc));
    }

    private static ReviewResult Result(IntegrationInvocation call, string status, string? verdict) =>
        new(Guid.NewGuid().ToString(), status == "Rejected" ? "review.rejected" : "review.finished", call.Id.ToString(), call.Id.ToString(),
            status == "Rejected" ? null : call.InstanceId.ToString(), status == "Rejected" ? null : Guid.NewGuid().ToString(),
            status == "Rejected" ? null : JsonNode.Parse(call.Payload)!["reviewer_subject"]!.ToString(), status == "Rejected" ? null : new ReviewRepository("team/app", new string('a', 40)),
            status, verdict, status == "Completed" ? "High" : null, status == "Rejected" ? null : "https://review.example.com/reviews/task",
            DateTimeOffset.UtcNow.ToString("O"), status is "Rejected" or "Failed" ? new ReviewError("DEPENDENCY_UNAVAILABLE", "依赖暂不可用", true, []) : null);
    private static ReviewMessageProperties Properties(ReviewResult result) => new(result.EventId, result.RequestId, result.EventType, "application/json", "utf-8", 2, DateTimeOffset.Parse(result.FinishedAt).ToUnixTimeSeconds());
    private static ReviewResult Parse(ReviewResult result) => CodeReviewProtocol.Parse(JsonSerializer.SerializeToUtf8Bytes(result, CodeReviewProtocol.JsonOptions), Properties(result));
    private static AigcHubDbContext Db() => new(new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
    private static async Task<(IntegrationWorkflowRunner, IntegrationInvocation, WorkflowInstance, PublicationRequest)> Start(AigcHubDbContext db)
    {
        await SeedData.InitializeAsync(db);
        db.IntegrationServices.Add(new IntegrationService { Code = "code-audit", Name = "代码审查", Kind = "Mq", IsEnabled = true, ConnectionKey = "Audit",
            OperationsJson = """[{"code":"review.requested","resultEvent":"review.finished","protocol":"code-review-20261112"}]""" });
        var definition = new ProcessDefinition { Key = "review-contract-test", Name = "审查", IsPublished = true, DefinitionJson = """
        {"executionMode":"integrated-v1","nodes":[
          {"id":"start","type":"start","name":"开始"},
          {"id":"audit","type":"serviceTask","name":"代码审查","serviceCode":"code-audit","operationCode":"review.requested","timeoutSeconds":86400},
          {"id":"approval","type":"userTask","name":"部署审批","assignmentType":"role","assignee":"workflow-admin"},
          {"id":"manual","type":"userTask","name":"人工复核","assignmentType":"role","assignee":"workflow-admin"},
          {"id":"failed","type":"end","name":"异常处理","result":"Failed"}],
         "edges":[{"source":"start","target":"audit"},{"source":"audit","target":"approval","outcome":"passed"},
          {"source":"audit","target":"manual","outcome":"needs-review"},{"source":"audit","target":"failed"},
          {"source":"approval","target":"failed"},{"source":"manual","target":"failed"}]}
        """ };
        var applicant = await db.Users.SingleAsync(u => u.EmployeeNo == "wh00412");
        var request = new PublicationRequest { AppName = "应用", RequestNo = "test", Summary = "说明", CommitSha = new string('a', 40), RepositoryFullName = "team/app", RepositoryUrl = "https://git.example.com/team/app", CategoryId = (await db.Categories.FirstAsync()).Id, ApplicantId = applicant.Id };
        var instance = new WorkflowInstance { ProcessDefinitionId = definition.Id, BusinessId = request.Id, BusinessType = "application-publication", InitiatorId = applicant.Id };
        db.AddRange(definition, request, instance); await db.SaveChangesAsync();
        var runner = new IntegrationWorkflowRunner(db, new WorkflowDefinitionReader(db));
        await runner.AdvanceAsync(definition, instance, request, null, "succeeded", default); await db.SaveChangesAsync();
        return (runner, await db.IntegrationInvocations.SingleAsync(), instance, request);
    }
}
