using System.Text.Json;

namespace AigcHub.Api.Contracts;

public sealed record LoginRequest(string EmployeeNo, string Password);
public sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, UserProfile User);
public sealed record UserProfile(Guid Id, string EmployeeNo, string Name, string Email, Guid? DepartmentId, string Department, string[] Roles, string[] Permissions);
public sealed record PageResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total);
public sealed record SaveDepartmentRequest(string Code, string Name, string Description, Guid? ManagerId, bool IsEnabled, Guid? BillingPlanId = null);
public sealed record SaveCategoryRequest(string Code, string Name, string Description, string Color, int SortOrder, bool IsEnabled, Guid? ParentId = null);
public sealed record SaveRoleRequest(string Code, string Name, string Description, string[] PermissionCodes);
public sealed record SaveUserRequest(string EmployeeNo, string Name, string Email, string? Password, Guid? DepartmentId, Guid[] RoleIds, bool IsEnabled, Guid[]? ModelIds = null, Guid[]? VirtualKeyIds = null, Guid[]? PluginIds = null, Guid[]? ReleaseIds = null, Guid[]? McpIds = null, Guid? BillingPlanId = null, bool? AllowCustomModels = null);
public sealed record SaveProcessDefinitionRequest(string Key, string Name, int Version, JsonElement Definition, bool IsPublished);
public sealed record AccessSubjectRequest(string SubjectType, Guid SubjectId);
public sealed record SubmitPublicationRequest(
    string AppName,
    Guid CategoryId,
    string Summary,
    string? AccessUrl = null,
    string? RepositoryUrl = null,
    string? Branch = null,
    string? CommitSha = null,
    string? Version = null,
    string? Environment = null,
    string? AccessMode = null,
    AccessSubjectRequest[]? AccessSubjects = null,
    AigcHub.Api.Services.GiteaSelection? CodeSource = null,
    string? ProcessKey = null);
public sealed record CompleteTaskRequest(string Action, string? Comment, Dictionary<string, object?>? Variables);
public sealed record CallbackRequest(string EventId, string CorrelationId, string Status, JsonElement Data);
public sealed record CallbackResult(bool Accepted, bool Duplicate, string? Message = null);
public sealed record AvailableAction(string Code, string Name);
public sealed record PublicationView(Guid Id, string RequestNo, string AppName, string Category, string Summary, string AccessUrl, string ApplicantName, string ApplicantDepartment, string Status, string CurrentNodeKey, string CurrentNodeName, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? ReviewComment, Guid? TaskId, AvailableAction[] AvailableActions, string? CorrelationId,
    string RepositoryUrl, string Branch, string CommitSha, string Version, string Environment,
    string AccessMode, string AccessScope, string ReviewerName, string? TaskName,
    string CandidateScope, string? AssigneeId, AuditSummaryView? Audit);

/// <summary>
/// Audit evidence taken from the third-party service result. The reviewer opens
/// DetailUrl to read the full report and decides based on what it shows.
/// </summary>
public sealed record AuditSummaryView(string NodeKey, string NodeName, string? Decision, string? Summary,
    string? DetailUrl, string? CommitSha, string? ExecutionStatus, string? IssueCount,
    string? Verdict = null, string? RiskLevel = null, string? TaskId = null, string? FinishedAt = null,
    string? ErrorCode = null, bool? Retryable = null, string? RepositoryFullName = null, string? ReviewerSubject = null);
public sealed record InboxNotificationView(Guid Id, string Title, string Content, string? Link, bool IsRead, DateTimeOffset CreatedAt);
public sealed record NotificationPage(IReadOnlyList<InboxNotificationView> Items, int Page, int PageSize, int Total, int UnreadCount);
public sealed record ChatMessageRequest(Guid? ConversationId, string Content, Guid? ModelId = null);
public sealed record CreateChatConversationRequest(string? Title, Guid? ModelId = null);
public sealed record RenameChatConversationRequest(string Title);
public sealed record ExecuteChatToolRequest(string ToolName, JsonElement Arguments);
public sealed record SaveModelConfigurationRequest(
    string Name, string ProviderKind, string BaseUrl, string EndpointPath, string ModelIdentifier,
    string? ApiKey, string AuthType, string ApiKeyHeader, bool SupportsTools, bool IsEnabled,
    bool IsDefault, double Temperature, int? MaxTokens, int SortOrder, string? ImageInputMode = null, string? Multiplier = null);
