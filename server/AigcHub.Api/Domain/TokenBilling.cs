namespace AigcHub.Api.Domain;

public sealed class TokenBillingPlan
{
    public DateTimeOffset? DeletedAt { get; set; }
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public long WeeklyTokens { get; set; }
    public bool IsEnabled { get; set; } = true;
}
public sealed class TokenBillingAssignment
{
    public string SubjectType { get; set; } = "User";
    public Guid SubjectId { get; set; }
    public Guid PlanId { get; set; }
}
public sealed class TokenBillingEntry
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid? DepartmentId { get; set; }
    public string EmployeeNo { get; set; } = "";
    public string UserName { get; set; } = "";
    public string DepartmentName { get; set; } = "";
    public Guid PlanId { get; set; }
    public Guid ModelId { get; set; }
    public string ModelName { get; set; } = "";
    public string ModelIdentifier { get; set; } = "";
    public DateTimeOffset WeekStart { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public decimal Multiplier { get; set; }
    public long ReservedTokens { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long TotalTokens { get; set; }
    public long ChargedTokens { get; set; }
    public string Status { get; set; } = "Pending";
    public string Note { get; set; } = "";
}

public sealed class TokenIncrementPackage
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public string UserName { get; set; } = "";
    public string EmployeeNo { get; set; } = "";
    public long Tokens { get; set; }
    public DateTimeOffset WeekStart { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public Guid? CreatedBy { get; set; }
    public string Reason { get; set; } = "";
}
