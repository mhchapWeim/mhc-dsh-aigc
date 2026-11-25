namespace AigcHub.Api.Domain;

public sealed class RequestProcessBinding
{
    public required string RequestType { get; set; }
    public required string ProcessKey { get; set; }
    public Guid? UpdatedById { get; set; }
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public enum AccessRequestStatus { Reviewing, Approved, Rejected, Failed }

public sealed class ApplicationAccessRequest
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public required string RequestNo { get; set; }
    public Guid ApplicantId { get; set; }
    public AppUser? Applicant { get; set; }
    public Guid? PublicationRequestId { get; set; }
    public PublicationRequest? Publication { get; set; }
    public Guid? RegisteredApplicationId { get; set; }
    public RegisteredApplication? RegisteredApplication { get; set; }
    public required string Reason { get; set; }
    public AccessRequestStatus Status { get; set; } = AccessRequestStatus.Reviewing;
    public string CurrentNodeKey { get; set; } = "start";
    public string CurrentNodeName { get; set; } = "提交";
    public string? ReviewComment { get; set; }
    public Guid? ReviewerId { get; set; }
    public Guid? ProcessInstanceId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid ConcurrencyToken { get; set; } = Guid.NewGuid();
}

public sealed class ApplicationPersonalGrant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public Guid? PublicationRequestId { get; set; }
    public Guid? RegisteredApplicationId { get; set; }
    public Guid AccessRequestId { get; set; }
    public string Source { get; set; } = "access-request";
    public DateTimeOffset GrantedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RevokedAt { get; set; }
    public Guid? RevokedById { get; set; }
    public string? RevokeReason { get; set; }
}

public sealed class ApplicationRoute
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid PublicationRequestId { get; set; }
    public required string Slug { get; set; }
    public required string UpstreamUrl { get; set; }
    public required string Status { get; set; }
    public string Detail { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ApplicationGatewaySetting
{
    public int Id { get; set; } = 1;
    public int IdleTimeoutMinutes { get; set; } = 30;
    public int MaxSessionHours { get; set; } = 8;
    public int LaunchTicketSeconds { get; set; } = 60;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? UpdatedById { get; set; }
}

public sealed class ApplicationGatewaySettingChange
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid ActorId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public string BeforeJson { get; set; } = "{}";
    public string AfterJson { get; set; } = "{}";
}

public sealed class ApplicationLaunchTicket
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public Guid PublicationRequestId { get; set; }
    public required string TokenHash { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
    public long AccessEpoch { get; set; }
    public int LifetimeSeconds { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class ApplicationGatewaySession
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public Guid PublicationRequestId { get; set; }
    public required string CookieHash { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset LastActivityAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset AbsoluteExpiresAt { get; set; }
    public int IdleTimeoutSeconds { get; set; }
    public long AccessEpoch { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
}
