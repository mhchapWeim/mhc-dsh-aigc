using System.Text.Json;

namespace AigcHub.Api.Contracts;

public sealed record LoginRequest(string EmployeeNo, string Password);
public sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, UserProfile User);
public sealed record UserProfile(Guid Id, string EmployeeNo, string Name, string Email, Guid? DepartmentId, string Department, string[] Roles, string[] Permissions);
public sealed record PageResult<T>(IReadOnlyList<T> Items, int Page, int PageSize, int Total);
public sealed record SaveDepartmentRequest(string Code, string Name, string Description, Guid? ManagerId, bool IsEnabled);
public sealed record SaveCategoryRequest(string Code, string Name, string Description, string Color, int SortOrder, bool IsEnabled);
public sealed record SaveRoleRequest(string Code, string Name, string Description, string[] PermissionCodes);
public sealed record SaveUserRequest(string EmployeeNo, string Name, string Email, string? Password, Guid? DepartmentId, Guid[] RoleIds, bool IsEnabled, Guid[]? ModelIds = null, Guid[]? VirtualKeyIds = null);
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
    AccessSubjectRequest[]? AccessSubjects = null);
public sealed record CompleteTaskRequest(string Action, string? Comment, Dictionary<string, object?>? Variables);
public sealed record CallbackRequest(string EventId, string CorrelationId, string Status, JsonElement Data);
public sealed record CallbackResult(bool Accepted, bool Duplicate, string? Message = null);
public sealed record AvailableAction(string Code, string Name);
public sealed record PublicationView(Guid Id, string RequestNo, string AppName, string Category, string Summary, string AccessUrl, string ApplicantName, string ApplicantDepartment, string Status, string CurrentNodeKey, string CurrentNodeName, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? ReviewComment, Guid? TaskId, AvailableAction[] AvailableActions, string? CorrelationId);
public sealed record ChatMessageRequest(Guid? ConversationId, string Content, Guid? ModelId = null);
public sealed record CreateChatConversationRequest(string? Title, Guid? ModelId = null);
public sealed record RenameChatConversationRequest(string Title);
public sealed record ExecuteChatToolRequest(string ToolName, JsonElement Arguments);
public sealed record SaveModelConfigurationRequest(
    string Name, string ProviderKind, string BaseUrl, string EndpointPath, string ModelIdentifier,
    string? ApiKey, string AuthType, string ApiKeyHeader, bool SupportsTools, bool IsEnabled,
    bool IsDefault, double Temperature, int? MaxTokens, int SortOrder, string? ImageInputMode = null, string? Multiplier = null);
