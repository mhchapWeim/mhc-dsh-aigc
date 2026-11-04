namespace AigcHub.Api.Domain;

public sealed class ApplicationClick
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid VisitId { get; set; }
    public Guid ApplicationId { get; set; }
    public Guid UserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class ApplicationClickAdjustment
{
    public Guid ApplicationId { get; set; }
    public string Period { get; set; } = "";
    public DateTimeOffset PeriodStart { get; set; }
    public long Offset { get; set; }
}
