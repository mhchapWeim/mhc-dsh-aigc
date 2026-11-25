namespace AigcHub.Api.Domain;

public sealed class RegisteredApplication
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string NameEn { get; set; } = "";
    public string Description { get; set; } = "";
    public string DescriptionEn { get; set; } = "";
    public string Owner { get; set; } = "";
    public string OwnerEn { get; set; } = "";
    /// <summary>访问申请的审核负责人。与展示用的负责人/团队分开保存，历史应用默认留空。</summary>
    public Guid? AccessReviewerId { get; set; }
    public string AccessUrl { get; set; } = "";
    public Guid CategoryId { get; set; }
    public AppCategory? Category { get; set; }
    public string CategoryEn { get; set; } = "";
    public bool IsEnabled { get; set; } = true;
    public int SortOrder { get; set; }
    public string AccessMode { get; set; } = "Subjects";
    // Reserved for the later approval-to-registry integration.
    public Guid? PublicationRequestId { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public ICollection<RegisteredApplicationGrant> Grants { get; set; } = [];
}

public sealed class RegisteredApplicationGrant
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid RegisteredApplicationId { get; set; }
    public RegisteredApplication Application { get; set; } = null!;
    public string SubjectType { get; set; } = "User";
    public Guid SubjectId { get; set; }
}
