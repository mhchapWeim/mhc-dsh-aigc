namespace AigcHub.Api.Domain;

public sealed class DesktopAnnouncement
{
    public string AudienceJson { get; set; } = "";
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
    public bool Important { get; set; }
    public string Status { get; set; } = "Draft";
    public DateTimeOffset StartsAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? EndsAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<DesktopAnnouncementRecipient> Recipients { get; set; } = [];
}

public sealed class DesktopAnnouncementRecipient
{
    public Guid AnnouncementId { get; set; }
    public DesktopAnnouncement Announcement { get; set; } = null!;
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public DateTimeOffset? DeliveredAt { get; set; }
    public DateTimeOffset? ReadAt { get; set; }
    public DateTimeOffset? ConfirmedAt { get; set; }
}

public sealed class DesktopRelease
{
    public string AudienceJson { get; set; } = "";
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Version { get; set; } = "";
    public string Notes { get; set; } = "";
    public string Platform { get; set; } = "win32";
    public string Arch { get; set; } = "x64";
    public string Status { get; set; } = "Draft";
    public string FileName { get; set; } = "";
    public string Sha512 { get; set; } = "";
    public long Bytes { get; set; }
    public bool HasBlockmap { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<DesktopReleaseRecipient> Recipients { get; set; } = [];
}

public sealed class DesktopReleaseRecipient
{
    public Guid ReleaseId { get; set; }
    public DesktopRelease Release { get; set; } = null!;
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
}

public sealed class DesktopClientReport
{
    public Guid UserId { get; set; }
    public AppUser User { get; set; } = null!;
    public string DeviceId { get; set; } = "";
    public string ComputerName { get; set; } = "";
    public string Version { get; set; } = "";
    public string Platform { get; set; } = "";
    public string Arch { get; set; } = "";
    public string UpdateStatus { get; set; } = "Current";
    public string TargetVersion { get; set; } = "";
    public string Error { get; set; } = "";
    public DateTimeOffset LastSeenAt { get; set; } = DateTimeOffset.UtcNow;
}
