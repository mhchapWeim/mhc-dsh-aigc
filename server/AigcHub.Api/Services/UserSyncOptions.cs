using System.ComponentModel.DataAnnotations;

namespace AigcHub.Api.Services;

public sealed class UserSyncOptions
{
    public bool Enabled { get; set; }
    [Required] public string HostName { get; set; } = "nj304";
    [Range(1, 65535)] public int Port { get; set; } = 5672;
    [Required] public string VirtualHost { get; set; } = "/aigc";
    [Required] public string Exchange { get; set; } = "aigc.identity.users";
    public string UserName { get; set; } = "";
    public string Password { get; set; } = "";
    public bool UseTls { get; set; }
    public string TlsServerName { get; set; } = "";
    [Range(1, 300)] public int PollSeconds { get; set; } = 5;
    [Range(1, 100)] public int MaximumAttempts { get; set; } = 10;
    public UserSyncConsumer[] Consumers { get; set; } = [];
}

public sealed class UserSyncConsumer
{
    public string ServiceName { get; set; } = "接收服务一";
    public string Queue { get; set; } = "aigc.users.service-1";
    public string UserName { get; set; } = "";
}
