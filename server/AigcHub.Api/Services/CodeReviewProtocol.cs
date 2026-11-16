using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using AigcHub.Api.Domain;

namespace AigcHub.Api.Services;

public sealed record ReviewRepository(string FullName, string CommitSha);
public sealed record ReviewParameters(string Name);
public sealed record ReviewRequest(string MessageId, string EventType, string RequestId, string WorkflowId,
    string ProducedAt, string DeadlineAt, string TraceId, string ReviewerSubject, ReviewRepository Repository, ReviewParameters Review);
public sealed record ReviewErrorDetail(string Field, string Code, string Message);
public sealed record ReviewError(string Code, string Message, bool Retryable, ReviewErrorDetail[] Details);
public sealed record ReviewResult(string EventId, string EventType, string RequestId, string RequestMessageId,
    string? WorkflowId, string? TaskId, string? ReviewerSubject, ReviewRepository? Repository,
    string Status, string? Verdict, string? Result, string? ReviewUrl, string FinishedAt, ReviewError? Error);
public sealed record ReviewMessageProperties(string? MessageId, string? CorrelationId, string? Type,
    string? ContentType, string? ContentEncoding, byte DeliveryMode, long Timestamp);

/// <summary>2026-11-12 code-review contract. Wire DTOs never leak into other service protocols.</summary>
public static class CodeReviewProtocol
{
    public const string Name = "code-review-20261112";
    public const int MaxBytes = 65536;
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        MaxDepth = 16
    };

    public static string SerializeRequest(IntegrationInvocation call, PublicationRequest request, string subject, string nodeName)
    {
        Text(subject, 1, 255, "reviewer_subject");
        Repository(new ReviewRepository(request.RepositoryFullName, request.CommitSha));
        Text(nodeName, 1, 160, "review.name");
        var produced = DateTimeOffset.UtcNow;
        if (call.ExpiresAt <= produced) throw Invalid("deadline_at 已过期");
        var body = JsonSerializer.Serialize(new ReviewRequest(call.Id.ToString(), "review.requested", call.Id.ToString(), call.InstanceId.ToString(),
            produced.ToString("O"), call.ExpiresAt.ToString("O"), call.InstanceId.ToString(), subject,
            new ReviewRepository(request.RepositoryFullName, request.CommitSha), new ReviewParameters(nodeName)), JsonOptions);
        if (Encoding.UTF8.GetByteCount(body) > MaxBytes) throw Invalid("请求超过 64 KiB");
        return body;
    }

    public static ReviewResult Parse(ReadOnlySpan<byte> body, ReviewMessageProperties properties)
    {
        if (body.Length > MaxBytes) throw Invalid("结果超过 64 KiB");
        try
        {
            // Duplicate keys are ambiguous even if a serializer would accept the last value.
            using var document = JsonDocument.Parse(body.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            UniqueProperties(document.RootElement);
            var result = JsonSerializer.Deserialize<ReviewResult>(body, JsonOptions) ?? throw Invalid("结果为空");
            Validate(result);
            if (properties.MessageId != result.EventId || properties.CorrelationId != result.RequestId || properties.Type != result.EventType ||
                properties.ContentType != "application/json" || properties.ContentEncoding != "utf-8" || properties.DeliveryMode != 2 ||
                properties.Timestamp != Time(result.FinishedAt, "finished_at").ToUnixTimeSeconds())
                throw Invalid("AMQP 属性与正文不一致");
            return result;
        }
        catch (JsonException) { throw Invalid("结果结构无效、缺少必填字段或包含未知字段"); }
    }

    public static void Validate(ReviewResult value)
    {
        Uuid(value.EventId, "event_id"); Uuid(value.RequestMessageId, "request_message_id");
        Text(value.RequestId, 8, 160, "request_id");
        if (!Regex.IsMatch(value.RequestId, "^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")) throw Invalid("request_id 格式无效");
        Time(value.FinishedAt, "finished_at");
        if (value.WorkflowId is not null) Text(value.WorkflowId, 1, 160, "workflow_id");
        if (value.TaskId is not null) Uuid(value.TaskId, "task_id");
        if (value.ReviewerSubject is not null) Text(value.ReviewerSubject, 1, 255, "reviewer_subject");
        if (value.Repository is not null) Repository(value.Repository);
        if (value.ReviewUrl is not null)
        {
            Text(value.ReviewUrl, 1, MaxBytes, "review_url");
            if (!Uri.TryCreate(value.ReviewUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo))
                throw Invalid("review_url 必须是 HTTPS 地址");
        }
        if (value.Status is not ("Completed" or "Failed" or "Cancelled" or "Rejected")) throw Invalid("status 无效");
        if (value.EventType != (value.Status == "Rejected" ? "review.rejected" : "review.finished")) throw Invalid("event_type 与 status 不一致");
        if (value.Status == "Rejected")
        {
            if (value.TaskId is not null || value.ReviewUrl is not null) throw Invalid("Rejected 不能包含 task_id 或 review_url");
        }
        else if (value.TaskId is null || value.ReviewUrl is null || value.WorkflowId is null || value.ReviewerSubject is null || value.Repository is null)
            throw Invalid("已登记任务必须包含任务、申请人、流程、仓库及详情链接");

        if (value.Status == "Completed")
        {
            if (value.Verdict is not ("Passed" or "Warning" or "Failed" or "Needs Review") ||
                value.Result is not ("Critical" or "High" or "Medium" or "Low" or "Info" or "Passed" or "Warning" or "Failed" or "Needs Review") || value.Error is not null)
                throw Invalid("Completed 的 verdict/result/error 不符合契约");
        }
        else if (value.Verdict is not null || value.Result is not null) throw Invalid("非 Completed 结果的 verdict/result 必须为 null");

        if (value.Status is "Failed" or "Rejected")
        {
            if (value.Error is null) throw Invalid("失败或请求拒绝必须提供 error");
            Text(value.Error.Code, 1, 160, "error.code"); Text(value.Error.Message, 1, 500, "error.message");
            if (value.Error.Details is null) throw Invalid("error.details 必须是数组");
            foreach (var detail in value.Error.Details)
            {
                if (detail is null) throw Invalid("error.details 条目不能为 null");
                Text(detail.Field, 1, 255, "error.details.field"); Text(detail.Message, 1, MaxBytes, "error.details.message");
                if (detail.Code is not ("REQUIRED" or "INVALID_TYPE" or "INVALID_FORMAT" or "OUT_OF_RANGE" or "UNKNOWN_FIELD")) throw Invalid("参数错误码无效");
            }
        }
        else if (value.Error is not null) throw Invalid("Completed/Cancelled 的 error 必须为 null");
    }

    public static void Match(ReviewResult result, IntegrationInvocation call)
    {
        var request = JsonSerializer.Deserialize<ReviewRequest>(call.Payload, JsonOptions) ?? throw Invalid("原请求快照无效");
        if (result.RequestId != request.RequestId || result.RequestMessageId != request.MessageId ||
            result.WorkflowId is not null && result.WorkflowId != request.WorkflowId ||
            result.ReviewerSubject is not null && result.ReviewerSubject != request.ReviewerSubject ||
            result.Repository is not null && (result.Repository.FullName != request.Repository.FullName || !string.Equals(result.Repository.CommitSha, request.Repository.CommitSha, StringComparison.OrdinalIgnoreCase)))
            throw Invalid("结果与原请求的关联、申请人或仓库版本不一致");
    }

    public static string Outcome(ReviewResult result) => result.Status switch
    {
        "Completed" => result.Verdict switch { "Passed" => "passed", "Failed" => "rejected", _ => "needs-review" },
        "Failed" => "failed", "Cancelled" => "cancelled", "Rejected" => "request-rejected", _ => throw Invalid("未知终态")
    };

    public static JsonElement Normalize(ReviewResult result) => JsonSerializer.SerializeToElement(new
    {
        protocol = Name, executionStatus = result.Status,
        decision = result.Status == "Completed" ? result.Verdict == "Failed" ? "Rejected" : result.Verdict : null,
        verdict = result.Verdict, riskLevel = result.Result, reportUrl = result.ReviewUrl,
        commitSha = result.Repository?.CommitSha, repositoryFullName = result.Repository?.FullName,
        taskId = result.TaskId, finishedAt = result.FinishedAt, reviewerSubject = result.ReviewerSubject,
        summary = result.Error?.Message, errorCode = result.Error?.Code, retryable = result.Error?.Retryable,
        raw = JsonSerializer.SerializeToElement(result, JsonOptions)
    }, IntegrationWorkflowRunner.JsonOptions);

    public static DateTimeOffset Time(string? value, string field)
    {
        if (value is null || !Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$") ||
            !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)) throw Invalid(field + " 必须为带时区的 ISO-8601 时间");
        return parsed;
    }
    private static void Text(string? value, int min, int max, string field)
    {
        if (value is null || value.Length < min || value.Length > max || value.Trim() != value || value.Any(char.IsControl)) throw Invalid(field + " 为空、超长或含非法空白/控制字符");
    }
    private static void Uuid(string? value, string field)
    {
        Text(value, 36, 36, field);
        if (!Guid.TryParseExact(value, "D", out _)) throw Invalid(field + " 必须是 UUID");
    }
    private static void Repository(ReviewRepository repository)
    {
        Text(repository.FullName, 3, 255, "repository.full_name");
        if (!Regex.IsMatch(repository.FullName, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") || repository.FullName.Split('/').Any(p => p is "." or "..")) throw Invalid("repository.full_name 格式无效");
        if (repository.CommitSha is null || !Regex.IsMatch(repository.CommitSha, "^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$")) throw Invalid("commit_sha 必须是完整 SHA");
    }
    private static void UniqueProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) { if (!names.Add(property.Name)) throw Invalid("消息包含重复字段"); UniqueProperties(property.Value); }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) UniqueProperties(item);
    }
    private static WorkflowException Invalid(string message) => new("代码审查协议：" + message);
}
