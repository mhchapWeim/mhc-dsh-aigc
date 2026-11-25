using System.Text.Json;
using System.Text.Json.Nodes;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record IntegrationOperation(string Code, string ResultEvent, string Protocol = "generic-v1");
public sealed record IntegrationResult(string MessageId, string ServiceCode, string EventType,
    Guid CorrelationId, string ExecutionStatus, JsonElement Data);

/// <summary>Single-token graph runner. Legacy definitions retain their original execution path.</summary>
public sealed class IntegrationWorkflowRunner(AigcHubDbContext db, WorkflowDefinitionReader reader, ApplicationRouteService? routes = null)
{
    public static bool IsIntegrated(ProcessDefinition definition) =>
        JsonNode.Parse(definition.DefinitionJson)?["executionMode"]?.GetValue<string>() == "integrated-v1";

    public async Task AdvanceAsync(ProcessDefinition definition, WorkflowInstance instance,
        PublicationRequest request, string? from, string outcome, CancellationToken ct)
    {
        var doc = JsonNode.Parse(definition.DefinitionJson)!;
        var nodes = doc["nodes"]!.AsArray();
        var edges = doc["edges"]!.AsArray();
        var current = from is null ? nodes.Single(n => Text(n, "type") == "start")! : nodes.Single(n => Text(n, "id") == from)!;
        for (var step = 0; step < 100; step++)
        {
            var outgoing = edges.Where(e => Text(e, "source") == Text(current, "id")).ToArray();
            var matched = outgoing.Where(e => Text(e, "outcome") == outcome).ToArray();
            var selected = matched.Length == 1 ? matched[0] : outgoing.SingleOrDefault(e => Text(e, "outcome") == "");
            if (selected is null) throw new WorkflowException($"节点 {Text(current, "id")} 没有匹配 {outcome} 的出口", 409);
            current = nodes.Single(n => Text(n, "id") == Text(selected, "target"))!;
            var key = Text(current, "id");
            instance.CurrentNodeKey = request.CurrentNodeKey = key;
            request.CurrentNodeName = Text(current, "name");
            instance.ConcurrencyToken = request.ConcurrencyToken = Guid.NewGuid();
            request.UpdatedAt = DateTimeOffset.UtcNow;
            instance.CompletedAt = null;
            switch (Text(current, "type"))
            {
                case "gateway": continue; // Explicit outcome edges; no eval or scripts.
                case "userTask":
                    var task = await reader.CreateNodeTaskAsync(definition, key, instance.Id, instance.InitiatorId, ct);
                    db.WorkflowTasks.Add(task);
                    await NotifyTaskAsync(task, request.AppName, ct);
                    instance.Status = WorkflowInstanceStatus.Running;
                    request.Status = PublicationStatus.Reviewing;
                    db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = key, EventType = "TaskCreated", Detail = task.Name });
                    return;
                case "serviceTask":
                    var code = Text(current, "serviceCode");
                    var service = await db.IntegrationServices.SingleOrDefaultAsync(s => s.Code == code && s.IsEnabled && s.Kind == "Mq", ct)
                        ?? throw new WorkflowException("第三方服务未启用", 409);
                    var operation = Text(current, "operationCode");
                    var operations = JsonSerializer.Deserialize<IntegrationOperation[]>(service.OperationsJson, JsonOptions)!;
                    var op = operations.SingleOrDefault(o => o.Code == operation)
                        ?? throw new WorkflowException("第三方操作不存在", 409);
                    var invocation = new IntegrationInvocation
                    {
                        Protocol = op.Protocol == "generic-v1" && operation == "review.requested" ? CodeReviewProtocol.Name : op.Protocol,
                        InstanceId = instance.Id, NodeKey = key, ServiceCode = code, ConnectionKey = service.ConnectionKey,
                        Operation = operation, ResultEvent = op.ResultEvent,
                        ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(current["timeoutSeconds"]?.GetValue<int>() ?? 86400)
                    };
                    if (invocation.Protocol == CodeReviewProtocol.Name)
                    {
                        if (!IntegrationDefinitionValidator.HasManualReviewPath(doc, key)) throw new WorkflowException("请配置代码审查 needs-review 到人工复核任务的出口", 409);
                        if (op.ResultEvent != "review.finished") throw new WorkflowException("代码审查操作的结果事件必须为 review.finished");
                        var applicant = await db.Users.SingleAsync(u => u.Id == request.ApplicantId, ct);
                        invocation.Payload = CodeReviewProtocol.SerializeRequest(invocation, request, applicant.EmployeeNo, Text(current, "name"));
                    }
                    else
                    {
                    if (invocation.Protocol != "generic-v1") throw new WorkflowException("不支持的第三方协议");
                    var inputs = new JsonObject();
                    var fields = JsonSerializer.SerializeToNode(new { request.RepositoryUrl, request.Branch, request.CommitSha,
                        request.Version, request.Environment, request.AppName }, JsonOptions)!;
                    foreach (var mapping in current["inputMappings"]?.AsObject() ?? new JsonObject())
                    {
                        var source = mapping.Value?.GetValue<string>() ?? "";
                        if (!source.StartsWith("request.", StringComparison.Ordinal) || fields[source[8..]] is null)
                            throw new WorkflowException($"输入映射无效：{source}");
                        inputs[mapping.Key] = fields[source[8..]]!.DeepClone();
                    }
                    if (current["inputMappings"] is null) inputs = fields.AsObject();
                    invocation.Payload = JsonSerializer.Serialize(new { schemaVersion = "1.0", messageId = invocation.Id,
                        serviceCode = code, operationCode = operation, correlationId = invocation.Id, data = inputs }, JsonOptions);
                    }
                    db.IntegrationInvocations.Add(invocation);
                    instance.Status = WorkflowInstanceStatus.WaitingCallback;
                    request.Status = PublicationStatus.Publishing;
                    db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = key, EventType = "ServiceRequested", Detail = invocation.Id.ToString() });
                    return;
                case "end":
                    var final = Text(current, "result");
                    if (final == "Rejected")
                    {
                        instance.Status = WorkflowInstanceStatus.Rejected;
                        request.Status = PublicationStatus.Rejected;
                    }
                    else if (final == "Failed")
                    {
                        instance.Status = WorkflowInstanceStatus.Failed;
                        request.Status = PublicationStatus.Failed;
                    }
                    else
                    {
                        if (!Uri.TryCreate(request.AccessUrl, UriKind.Absolute, out var url) || url.Scheme != "https")
                            throw new WorkflowException("发布完成前必须有有效的 HTTPS 部署地址", 409);
                        instance.Status = WorkflowInstanceStatus.Completed;
                        request.Status = PublicationStatus.Approved;
                        if (routes is not null) await routes.RegisterAsync(request, request.AccessUrl, ct);
                    }
                    instance.CompletedAt = DateTimeOffset.UtcNow;
                    db.Notifications.Add(new InboxNotification { UserId = request.ApplicantId, Title = $"申请处理结果：{request.AppName}", Content = request.CurrentNodeName, Link = "/admin/publications" });
                    return;
                default: throw new WorkflowException("不支持的执行节点", 409);
            }
        }
        throw new WorkflowException("自动节点循环超过上限", 409);
    }

    public async Task<bool> ReceiveAsync(string trustedService, IntegrationResult result, CancellationToken ct)
        => await ReceiveCoreAsync(trustedService, result, null, ct);

    internal const string DeploymentServiceCode = "deployment";
    internal const string DeploymentCompletedEvent = "deploy.completed.v1";

    public Task<bool> CompleteDeploymentManuallyAsync(Guid invocationId, string? deploymentUrl, Guid actorId, CancellationToken ct)
    {
        var submitted = deploymentUrl?.Trim();
        if (submitted is null || submitted.Length > 2048 || !Uri.TryCreate(submitted, UriKind.Absolute, out var url) ||
            url.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(url.UserInfo))
            throw new WorkflowException("请输入有效的 HTTPS 部署地址，且地址不能包含账号或密码");

        var result = new IntegrationResult($"manual-deployment:{invocationId:N}", DeploymentServiceCode,
            DeploymentCompletedEvent, invocationId, "Succeeded", JsonSerializer.SerializeToElement(new { deploymentUrl = url.AbsoluteUri }));
        return ReceiveCoreAsync(DeploymentServiceCode, result, null, ct, actorId);
    }

    public async Task<bool> ReceiveMessageAsync(string trustedService, ReadOnlyMemory<byte> body, ReviewMessageProperties properties, CancellationToken ct)
    {
        if (body.Length > 262144) throw new WorkflowException("结果消息过大");
        using var document = JsonDocument.Parse(body);
        if (document.RootElement.ValueKind == JsonValueKind.Object &&
            (document.RootElement.TryGetProperty("event_id", out _) || document.RootElement.TryGetProperty("event_type", out _)))
            return await ReceiveReviewAsync(trustedService, CodeReviewProtocol.Parse(body.Span, properties), ct);
        var generic = JsonSerializer.Deserialize<IntegrationResult>(body.Span, JsonOptions) ?? throw new WorkflowException("结果格式无效");
        return await ReceiveAsync(trustedService, generic, ct);
    }

    public async Task<bool> ReceiveReviewAsync(string trustedService, ReviewResult review, CancellationToken ct)
    {
        CodeReviewProtocol.Validate(review);
        if (!Guid.TryParseExact(review.RequestId, "D", out var id)) throw new WorkflowException("找不到对应的审查调用", 404);
        return await ReceiveCoreAsync(trustedService, new IntegrationResult(Guid.Parse(review.EventId).ToString(), trustedService, "review.finished", id, review.Status, CodeReviewProtocol.Normalize(review)), review, ct);
    }

    private async Task<bool> ReceiveCoreAsync(string trustedService, IntegrationResult result, ReviewResult? review, CancellationToken ct,
        Guid? manualActorId = null)
    {
        if (trustedService != result.ServiceCode || string.IsNullOrWhiteSpace(result.MessageId) || result.MessageId.Length > 200)
            throw new WorkflowException("结果来源或消息标识无效", 403);
        if (result.Data.ValueKind != JsonValueKind.Object) throw new WorkflowException("结果 data 必须是对象");
        await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
        if (db.Database.IsNpgsql())
            await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtext({result.CorrelationId.ToString()}))", ct);
        if (await db.IntegrationReceipts.AnyAsync(r => r.ServiceCode == trustedService && r.MessageId == result.MessageId, ct)) return true;
        var call = await db.IntegrationInvocations.SingleOrDefaultAsync(x => x.Id == result.CorrelationId, ct)
            ?? throw new WorkflowException("找不到调用记录", 404);
        if (call.Protocol != (review is null ? "generic-v1" : CodeReviewProtocol.Name)) throw new WorkflowException("结果协议与调用快照不一致", 409);
        if (review is not null) CodeReviewProtocol.Match(review, call);
        if (call.ServiceCode != trustedService || call.ResultEvent != result.EventType) throw new WorkflowException("结果事件不匹配", 403);
        var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == call.InstanceId, ct);
        var request = await db.PublicationRequests.SingleAsync(x => x.Id == instance.BusinessId, ct);
        var active = (call.Status is "Pending" or "Sent" or "DeliveryFailed") && instance.Status == WorkflowInstanceStatus.WaitingCallback && instance.CurrentNodeKey == call.NodeKey;
        var disposition = !active ? "Stale" : call.ExpiresAt <= DateTimeOffset.UtcNow ? "Expired" : "Applied";
        if (manualActorId.HasValue && disposition != "Applied")
            throw new WorkflowException("只能触发当前流程节点尚未过期的部署调用，请刷新记录", 409);
        if (disposition == "Applied" && review is { Status: "Rejected", Error: { Code: "REQUEST_CONFLICT" } })
        {
            disposition = "RequestConflict";
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = call.NodeKey, EventType = "ReviewRequestConflict", Detail = review.EventId });
            db.Notifications.Add(new InboxNotification { UserId = request.ApplicantId, Title = "代码审查请求冲突", Content = "原审查仍在等待结果，请联系管理员检查请求记录", Link = "/admin/publications" });
        }
        if (disposition == "Applied")
        {
            if (review is null && result.ExecutionStatus is not ("Succeeded" or "Failed")) throw new WorkflowException("只接受最终执行结果");
            var definition = await db.ProcessDefinitions.SingleAsync(x => x.Id == instance.ProcessDefinitionId, ct);
            var node = JsonNode.Parse(definition.DefinitionJson)!["nodes"]!.AsArray().Single(n => Text(n, "id") == call.NodeKey)!;
            var deploymentField = Text(node, "deploymentUrlField");
            if (manualActorId is Guid actorId)
            {
                if (deploymentField.Length == 0)
                    throw new WorkflowException("该节点未配置部署地址结果字段，不能手动触发", 409);
                if (node["verifyCommit"]?.ToJsonString() == "true")
                    throw new WorkflowException("该部署节点要求验证提交版本，请使用带 commitSha 的部署回调", 409);
                var url = result.Data.GetProperty("deploymentUrl").GetString();
                result = result with { Data = JsonSerializer.SerializeToElement(new Dictionary<string, string?> { [deploymentField] = url }) };
                db.WorkflowHistory.Add(new WorkflowHistory
                {
                    InstanceId = instance.Id, NodeKey = call.NodeKey, ActorId = actorId,
                    EventType = "ManualDeploymentCompleted", Detail = call.Id.ToString()
                });
            }
            if (review is null && result.ExecutionStatus == "Succeeded" && node["verifyCommit"]?.ToJsonString() == "true")
            {
                if (!result.Data.TryGetProperty("commitSha", out var commit) || commit.ValueKind != JsonValueKind.String || !string.Equals(commit.GetString(), request.CommitSha, StringComparison.OrdinalIgnoreCase))
                    throw new WorkflowException("结果 Commit 与申请不一致", 409);
            }
            var outcome = review is not null ? CodeReviewProtocol.Outcome(review) : result.ExecutionStatus == "Failed" ? "failed" : "succeeded";
            var decisionRequired = Text(node, "resultMode") == "decision" || call.Operation == "audit.submit.v1";
            if (review is null && result.ExecutionStatus == "Succeeded" && deploymentField.Length == 0)
            {
                if (result.Data.TryGetProperty("decision", out var decision))
                    outcome = decision.ValueKind == JsonValueKind.String ? decision.GetString() switch { "Passed" => "passed", "Rejected" => "rejected", _ => throw new WorkflowException("审核结论无效") } : throw new WorkflowException("审核结论必须是字符串");
                else if (decisionRequired) throw new WorkflowException("审计成功结果必须包含 decision=Passed 或 Rejected");
            }
            if (review is null && result.ExecutionStatus == "Succeeded" && deploymentField.Length > 0)
            {
                if (!result.Data.TryGetProperty(deploymentField, out var property) || property.ValueKind != JsonValueKind.String || !Uri.TryCreate(property.GetString(), UriKind.Absolute, out var url) || url.Scheme != "https")
                    throw new WorkflowException("部署结果缺少有效的 HTTPS 地址");
                request.AccessUrl = url.ToString();
            }
            var variables = JsonNode.Parse(instance.VariablesJson)!.AsObject();
            variables["nodes"] ??= new JsonObject();
            variables["nodes"]![call.NodeKey] = JsonNode.Parse(result.Data.GetRawText());
            instance.VariablesJson = variables.ToJsonString();
            call.Status = "Completed";
            call.ResultJson = review is null ? JsonSerializer.Serialize(result, JsonOptions) : JsonSerializer.Serialize(review, CodeReviewProtocol.JsonOptions);
            call.ConcurrencyToken = Guid.NewGuid();
            await AdvanceAsync(definition, instance, request, call.NodeKey, outcome, ct);
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = instance.Id, NodeKey = call.NodeKey, EventType = "ServiceResult", Detail = outcome });
        }
        db.IntegrationReceipts.Add(new IntegrationReceipt { ServiceCode = trustedService, MessageId = result.MessageId, InvocationId = call.Id, Disposition = disposition,
            PayloadJson = review is null ? "{}" : JsonSerializer.Serialize(review, CodeReviewProtocol.JsonOptions) });
        await db.SaveChangesAsync(ct);
        if (tx is not null) await tx.CommitAsync(ct);
        return disposition != "Applied";
    }

    internal static string Text(JsonNode? node, string key) => node?[key]?.ToString() ?? "";
    internal static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private async Task NotifyTaskAsync(WorkflowTask task, string appName, CancellationToken ct)
    {
        var users = await db.Users.Where(x => x.IsEnabled).Include(x => x.Department).Include(x => x.Roles).ThenInclude(x => x.Role).ToListAsync(ct);
        foreach (var user in users.Where(u => task.Candidates.Any(c => c.Type switch {
            "user" => c.Value == u.Id.ToString(), "department" => c.Value == u.Department?.Code,
            "role" => u.Roles.Any(r => r.Role.Code == c.Value), _ => false
        })))
            db.Notifications.Add(new InboxNotification { UserId = user.Id, Title = $"待处理申请：{appName}", Content = task.Name, Link = "/admin/reviews" });
    }
}
