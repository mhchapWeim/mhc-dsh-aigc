namespace AigcHub.Api.Domain;

public sealed class Department
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Code { get; set; }
    public required string Name { get; set; }
    public string Description { get; set; } = "";
    public Guid? ManagerId { get; set; }
    public bool IsEnabled { get; set; } = true;
}

public sealed class Role
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Code { get; set; }
    public required string Name { get; set; }
    public string Description { get; set; } = "";
    public bool IsBuiltIn { get; set; }
    public ICollection<UserRole> Users { get; set; } = [];
    public ICollection<RolePermission> Permissions { get; set; } = [];
}

public sealed class Permission
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Code { get; set; }
    public required string Name { get; set; }
    public required string PagePath { get; set; }
}

public sealed class AppUser
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string EmployeeNo { get; set; }
    public required string Name { get; set; }
    public required string Email { get; set; }
    public required string PasswordHash { get; set; }
    public Guid DepartmentId { get; set; }
    public Department? Department { get; set; }
    public bool IsEnabled { get; set; } = true;
    public DateTimeOffset? LastLoginAt { get; set; }
    public ICollection<UserRole> Roles { get; set; } = [];
}

public sealed class UserRole
{
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public Guid RoleId { get; set; }
    public Role Role { get; set; } = null!;
}

public sealed class RolePermission
{
    public Guid RoleId { get; set; }
    public Role Role { get; set; } = null!;
    public Guid PermissionId { get; set; }
    public Permission Permission { get; set; } = null!;
}

public sealed class AppCategory
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Code { get; set; }
    public required string Name { get; set; }
    public string Description { get; set; } = "";
    public string Color { get; set; } = "#2465d0";
    public int SortOrder { get; set; }
    public bool IsEnabled { get; set; } = true;
}

public sealed class ProcessDefinition
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Key { get; set; }
    public required string Name { get; set; }
    public int Version { get; set; } = 1;
    public string DefinitionJson { get; set; } = "{}";
    public bool IsPublished { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public enum PublicationStatus { Draft, Reviewing, Publishing, Approved, Rejected, Failed }
public enum WorkflowInstanceStatus { Running, WaitingCallback, Completed, Rejected, Failed }
public enum WorkflowTaskStatus { Pending, Completed, Cancelled }

public sealed class PublicationRequest
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string RequestNo { get; set; }
    public required string AppName { get; set; }
    public required string Summary { get; set; }
    public string AccessUrl { get; set; } = "";
    public string RepositoryUrl { get; set; } = "";
    public string Branch { get; set; } = "";
    public string CommitSha { get; set; } = "";
    public string Version { get; set; } = "";
    public string Environment { get; set; } = "Production";
    public string AccessMode { get; set; } = "All";
    public Guid CategoryId { get; set; }
    public AppCategory? Category { get; set; }
    public Guid ApplicantId { get; set; }
    public AppUser? Applicant { get; set; }
    public PublicationStatus Status { get; set; } = PublicationStatus.Draft;
    public string CurrentNodeKey { get; set; } = "draft";
    public string CurrentNodeName { get; set; } = "草稿";
    public string? ReviewComment { get; set; }
    public Guid? ReviewerId { get; set; }
    public Guid? ProcessInstanceId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid ConcurrencyToken { get; set; } = Guid.NewGuid();
    public ICollection<PublicationAccessGrant> AccessGrants { get; set; } = [];
}

public sealed class PublicationAccessGrant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PublicationRequestId { get; set; }
    public PublicationRequest PublicationRequest { get; set; } = null!;
    public required string SubjectType { get; set; }
    public Guid SubjectId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class WorkflowInstance
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ProcessDefinitionId { get; set; }
    public Guid BusinessId { get; set; }
    public required string BusinessType { get; set; }
    public Guid InitiatorId { get; set; }
    public WorkflowInstanceStatus Status { get; set; } = WorkflowInstanceStatus.Running;
    public string CurrentNodeKey { get; set; } = "start";
    public string VariablesJson { get; set; } = "{}";
    public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
    public Guid ConcurrencyToken { get; set; } = Guid.NewGuid();
}

public sealed class WorkflowTask
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid InstanceId { get; set; }
    public required string NodeKey { get; set; }
    public required string Name { get; set; }
    public WorkflowTaskStatus Status { get; set; } = WorkflowTaskStatus.Pending;
    public Guid? AssigneeId { get; set; }
    public Guid? CompletedById { get; set; }
    public string? Decision { get; set; }
    public string? Comment { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
    public ICollection<WorkflowTaskCandidate> Candidates { get; set; } = [];
}

public sealed class WorkflowTaskCandidate
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TaskId { get; set; }
    public WorkflowTask Task { get; set; } = null!;
    public required string Type { get; set; }
    public required string Value { get; set; }
}

public sealed class WorkflowCallbackSubscription
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid InstanceId { get; set; }
    public required string EventType { get; set; }
    public required string CorrelationId { get; set; }
    public bool IsConsumed { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
}

public sealed class WorkflowCallbackInbox
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string EventId { get; set; }
    public required string CorrelationId { get; set; }
    public required string PayloadJson { get; set; }
    public DateTimeOffset ReceivedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class WorkflowHistory
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid InstanceId { get; set; }
    public required string EventType { get; set; }
    public required string NodeKey { get; set; }
    public Guid? ActorId { get; set; }
    public string Detail { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class InboxNotification
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public required string Title { get; set; }
    public required string Content { get; set; }
    public string? Link { get; set; }
    public bool IsRead { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public enum ChatToolExecutionStatus { AwaitingConfirmation, Running, Succeeded, Failed, Cancelled }

public sealed class ChatConversation
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public AppUser? User { get; set; }
    public Guid? ModelConfigurationId { get; set; }
    public string Title { get; set; } = "新对话";
    public bool IsArchived { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public ICollection<ChatMessage> Messages { get; set; } = [];
}

public sealed class AiModelConfiguration
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Name { get; set; }
    public string ProviderKind { get; set; } = "Online";
    public string Protocol { get; set; } = "OpenAICompatible";
    public required string BaseUrl { get; set; }
    public string EndpointPath { get; set; } = "/chat/completions";
    public required string ModelIdentifier { get; set; }
    public string ApiKeyProtected { get; set; } = "";
    public string AuthType { get; set; } = "Bearer";
    public string ApiKeyHeader { get; set; } = "X-API-Key";
    public bool SupportsTools { get; set; } = true;
    public bool IsEnabled { get; set; } = true;
    public bool IsDefault { get; set; }
    public double Temperature { get; set; } = 0.3;
    public int? MaxTokens { get; set; }
    public int SortOrder { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ChatMessage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ConversationId { get; set; }
    public ChatConversation Conversation { get; set; } = null!;
    public required string Role { get; set; }
    public required string Content { get; set; }
    public Guid? ToolExecutionId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ChatToolExecution
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ConversationId { get; set; }
    public Guid UserId { get; set; }
    public required string ToolName { get; set; }
    public string ArgumentsJson { get; set; } = "{}";
    public ChatToolExecutionStatus Status { get; set; }
    public bool RequiresConfirmation { get; set; }
    public string? ResultJson { get; set; }
    public string? Error { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? ConfirmedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}

public sealed class OperationAudit
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public required string Action { get; set; }
    public required string EntityType { get; set; }
    public string? EntityId { get; set; }
    public string DetailJson { get; set; } = "{}";
    public bool Succeeded { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ManagedVirtualKey
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Alias { get; set; }
    public required string KeyProtected { get; set; }
    public bool IsEnabled { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class VirtualKeyOrganization
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string Name { get; set; }
}

public sealed class VirtualKeyOrganizationMember
{
    public Guid OrganizationId { get; set; }
    public Guid UserId { get; set; }
}
