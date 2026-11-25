using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using System.Text.Json.Serialization;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Endpoints;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Microsoft.Extensions.Options;
using Yarp.ReverseProxy.Forwarder;

namespace AigcHub.Api.Configuration;

public static class ApplicationConfiguration
{
    private static readonly string[] Permissions =
    [
        "portal.view", "admin.view", "publication.create", "publication.review", "process.design", "gateway.manage",
        "user.manage", "department.manage", "category.manage", "role.manage", "model.manage", "announcement.manage", "client-release.manage", "diagnostic.manage", "plugin.manage", "mcp.manage"
    ];

    public static void AddAigcHubServices(this WebApplicationBuilder builder)
    {
        builder.Logging.ClearProviders();
        // HttpClient's default information logs include full URLs (including CAS tickets).
        builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
        var fileLogging = builder.Configuration.GetSection("FileLogging").Get<FileLogOptions>() ?? new FileLogOptions();
        fileLogging.Directory = Path.GetFullPath(fileLogging.Directory, builder.Environment.ContentRootPath);
        builder.Services.AddSingleton<ILoggerProvider>(_ => new RollingFileLoggerProvider(fileLogging));

        var connectionString = builder.Configuration.GetConnectionString("PostgreSql")
            ?? throw new InvalidOperationException("缺少 ConnectionStrings:PostgreSql");
        builder.Services.AddDbContext<AigcHubDbContext>(options => options.UseNpgsql(connectionString));

        builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection("Jwt"));
        builder.Services.Configure<CasOptions>(builder.Configuration.GetSection("Cas"));
        builder.Services.Configure<McpIdentityAssertionOptions>(builder.Configuration.GetSection("McpIdentityAssertion"));
        builder.Services.Configure<ChatOptions>(builder.Configuration.GetSection("Chat"));
        builder.Services.Configure<LiteLlmOptions>(builder.Configuration.GetSection("LiteLlm"));
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>() ?? new JwtOptions();
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
            options.Events = new JwtBearerEvents
            {
                OnTokenValidated = async context =>
                {
                    var id = context.Principal?.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
                    var db = context.HttpContext.RequestServices.GetRequiredService<AigcHubDbContext>();
                    if (!Guid.TryParse(id, out var userId) || !await db.Users.AnyAsync(x => x.Id == userId, context.HttpContext.RequestAborted))
                        context.Fail("用户不存在或已删除");
                }
            };
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidateAudience = true,
                ValidateLifetime = true,
                ValidateIssuerSigningKey = true,
                ValidIssuer = jwt.Issuer,
                ValidAudience = jwt.Audience,
                IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.Key)),
                ClockSkew = TimeSpan.FromMinutes(1)
            };
        });
        builder.Services.AddAuthorization(options =>
        {
            foreach (var permission in Permissions)
                options.AddPolicy(permission, policy => policy.RequireClaim("permission", permission));
        });

        builder.Services.AddHttpContextAccessor();
        builder.Services.AddRateLimiter(options => {
            options.RejectionStatusCode = 429;
            options.AddPolicy("installer-diagnostics", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions {
                    PermitLimit = 30, Window = TimeSpan.FromMinutes(1), QueueLimit = 0
                }));
        });
        builder.Services.AddHostedService<DshFailureCleanup>();
        var configuredKeyPath = builder.Configuration["DataProtection:KeysPath"];
        var keyPath = string.IsNullOrWhiteSpace(configuredKeyPath)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AigcHub", "data-protection")
            : Path.GetFullPath(configuredKeyPath, builder.Environment.ContentRootPath);
        builder.Services.AddDataProtection()
            .SetApplicationName("AigcHub.Api")
            .PersistKeysToFileSystem(new DirectoryInfo(keyPath));
        builder.Services.AddScoped<ICurrentUser, CurrentUser>();
        builder.Services.AddScoped<TokenService>();
        builder.Services.AddSingleton<McpIdentityAssertionIssuer>();
        builder.Services.AddSingleton<CasDeviceLoginStore>();
        builder.Services.AddScoped<CasAuthenticationService>();
        builder.Services.AddScoped<PortalSsoFlow>();
        builder.Services.AddScoped<WorkflowDefinitionReader>();
        builder.Services.AddScoped<IntegrationWorkflowRunner>();
        builder.Services.AddScoped<GiteaService>();
        builder.Services.AddHostedService<IntegrationMqWorker>();
        builder.Services.AddHttpClient("gitea", client => client.Timeout = TimeSpan.FromSeconds(30))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
        builder.Services.AddHttpClient("gitea-insecure", client => client.Timeout = TimeSpan.FromSeconds(30))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler {
                AllowAutoRedirect = false, UseCookies = false,
                ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
            });
        builder.Services.AddScoped<WorkflowService>();
        builder.Services.AddScoped<ApplicationRouteService>();
        builder.Services.AddScoped<GatewaySettingsService>();
        builder.Services.AddScoped<LaunchTicketService>();
        builder.Services.AddScoped<GatewaySessionService>();
        AddGatewayUpstreamServices(builder.Services);
        builder.Services.AddScoped<IRealtimeNotificationPublisher, SignalRNotificationPublisher>();
        builder.Services.AddScoped<DatabasePermissionService>();
        builder.Services.AddScoped<ChatToolRegistry>();
        builder.Services.AddScoped<ChatToolExecutionService>();
        builder.Services.AddScoped<ChatOrchestrator>();
        builder.Services.AddScoped<IChatTool, OpenApplicationTool>();
        builder.Services.AddScoped<IChatTool, CreatePublicationRequestTool>();
        builder.Services.AddScoped<IChatTool, CreateUserTool>();
        builder.Services.AddScoped<IChatTool, CreateDepartmentTool>();
        builder.Services.AddScoped<IChatTool, CreateCategoryTool>();
        builder.Services.AddHttpClient();
        builder.Services.AddHttpClient("mcp-gateway", client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
        builder.Services.AddHttpClient("bocha-web-search", client => client.Timeout = TimeSpan.FromSeconds(30))
            .ConfigurePrimaryHttpMessageHandler(() => CreateLiteLlmHttpHandler(
                builder.Configuration.GetValue("BochaSearch:VerifySsl", true), false));
        builder.Services.AddHttpClient("deepseek-web-search", client => client.Timeout = TimeSpan.FromSeconds(45))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        builder.Services.AddHttpClient("dsh-managed-upstream").ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false
        });
        var liteLlm = builder.Configuration.GetSection("LiteLlm").Get<LiteLlmOptions>() ?? new LiteLlmOptions();
        builder.Services.AddHttpClient("litellm-model-sync", client =>
        {
            client.Timeout = TimeSpan.FromSeconds(Math.Max(1, liteLlm.TimeoutSeconds));
        }).ConfigurePrimaryHttpMessageHandler(() => CreateLiteLlmHttpHandler(liteLlm.VerifySsl, false));
        builder.Services.AddHttpClient("litellm-key-management", client =>
        {
            client.Timeout = TimeSpan.FromSeconds(Math.Max(1, liteLlm.TimeoutSeconds));
        }).ConfigurePrimaryHttpMessageHandler(() => CreateLiteLlmHttpHandler(liteLlm.VerifySsl, false));
        builder.Services.AddHttpClient("litellm-chat")
            .ConfigurePrimaryHttpMessageHandler(() => CreateLiteLlmHttpHandler(liteLlm.VerifySsl, false));
        builder.Services.AddHttpClient("dsh-managed-upstream-litellm")
            .ConfigurePrimaryHttpMessageHandler(() => CreateLiteLlmHttpHandler(liteLlm.VerifySsl, false));
        var cas = builder.Configuration.GetSection("Cas").Get<CasOptions>() ?? new CasOptions();
        builder.Services.AddHttpClient("bhss-cas", client =>
        {
            client.Timeout = TimeSpan.FromSeconds(Math.Max(1, cas.RequestTimeoutSeconds));
        }).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
        {
            AllowAutoRedirect = false,
            ServerCertificateCustomValidationCallback = cas.VerifySsl
                ? null
                : HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
        });
        builder.Services.AddOptions<UserSyncOptions>().Bind(builder.Configuration.GetSection("UserSync"))
            .ValidateDataAnnotations().Validate(x => !x.Enabled || (!string.IsNullOrWhiteSpace(x.UserName) && !string.IsNullOrWhiteSpace(x.Password)),
                "启用用户同步时必须配置独立的 MQ 生产账号和密码")
            .Validate(x => x.Consumers.All(c => !string.IsNullOrWhiteSpace(c.ServiceName) && !string.IsNullOrWhiteSpace(c.Queue))
                && x.Consumers.Select(c => c.Queue).Distinct().Count() == x.Consumers.Length, "接收服务必须有名称和唯一队列").ValidateOnStart();
        builder.Services.AddSingleton<IUserSyncPublisher, RabbitUserSyncPublisher>();
        builder.Services.AddScoped<UserSyncDispatcher>();
        builder.Services.AddHostedService<UserSyncWorker>();
        builder.Services.AddOptions<ConfigSyncOptions>().Bind(builder.Configuration.GetSection("ConfigSync"))
            .ValidateDataAnnotations().Validate(x => !x.Enabled || (!string.IsNullOrWhiteSpace(x.UserName) && !string.IsNullOrWhiteSpace(x.Password)),
                "启用配置热更新 MQ 时必须提供专用运行账号和密码").ValidateOnStart();
        builder.Services.AddSingleton<ConfigSyncSignals>();
        builder.Services.AddScoped<ConfigSyncService>();
        builder.Services.AddHostedService<ConfigSyncWorker>();
        builder.Services.AddScoped<TokenBillingService>();
        builder.Services.AddScoped<ModelConfigurationService>();
        builder.Services.AddScoped<AccessGrantService>();
        builder.Services.AddScoped<LiteLlmModelSyncService>();
        builder.Services.AddScoped<LiteLlmVirtualKeyService>();
        builder.Services.Configure<BackupStorageOptions>(builder.Configuration.GetSection("BackupStorage"));
        builder.Services.AddSingleton<IBackupObjectStore, BackupObjectStore>();
        builder.Services.AddHostedService<BackupTransferCleanup>();
        builder.Services.AddScoped<ChatModelClient>();
        builder.Services.AddScoped<IPasswordHasher<AppUser>, PasswordHasher<AppUser>>();
        builder.Services.AddSignalR();
        builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
            .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:3000"])
            .AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
        builder.Services.ConfigureHttpJsonOptions(options =>
            options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
        builder.Services.AddEndpointsApiExplorer();
        builder.Services.AddSwaggerGen(options =>
        {
            options.SwaggerDoc("v1", new OpenApiInfo
            {
                Title = "BHSS AIGC Hub API", Version = "v1",
                Description = "企业智能应用中台、动态 RBAC 与轻量流程引擎 API"
            });
            options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
            {
                Name = "Authorization", Type = SecuritySchemeType.Http, Scheme = "bearer",
                BearerFormat = "JWT", In = ParameterLocation.Header
            });
            options.AddSecurityRequirement(new OpenApiSecurityRequirement
            {
                [new OpenApiSecurityScheme
                {
                    Reference = new OpenApiReference { Type = ReferenceType.SecurityScheme, Id = "Bearer" }
                }] = []
            });
        });
    }

    private static SocketsHttpHandler CreateGatewayForwarderHandler(bool acceptInvalidCertificates)
    {
        var handler = new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, ActivityHeadersPropagator = null };
        if (acceptInvalidCertificates)
            handler.SslOptions.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
        return handler;
    }

    internal const string GatewayUntrustedUpstream = "gateway-untrusted-upstream";

    internal static bool CanAcceptInvalidGatewayCertificate(IConfiguration configuration, Uri upstream) =>
        upstream.Scheme == Uri.UriSchemeHttps &&
        configuration.GetValue("ApplicationGateway:AcceptInvalidUpstreamCertificates", false) &&
        (configuration.GetSection("ApplicationGateway:AllowedUpstreamHosts").Get<string[]>() ?? [])
            .Any(host => string.Equals(host.Trim(), upstream.IdnHost, StringComparison.OrdinalIgnoreCase));

    private static void AddGatewayUpstreamServices(IServiceCollection services)
    {
        services.AddSingleton<IUpstreamProbe, HttpUpstreamProbe>();
        services.AddHttpForwarder();
        services.AddSingleton(_ => new HttpMessageInvoker(CreateGatewayForwarderHandler(false)));
        services.AddKeyedSingleton(GatewayUntrustedUpstream, (_, _) => new HttpMessageInvoker(CreateGatewayForwarderHandler(true)));
        services.AddHttpClient("upstream-probe", client => client.Timeout = TimeSpan.FromSeconds(5))
            .ConfigurePrimaryHttpMessageHandler(provider =>
            {
                var configuration = provider.GetRequiredService<IConfiguration>();
                return new HttpClientHandler
                {
                    AllowAutoRedirect = false,
                    UseCookies = false,
                    ServerCertificateCustomValidationCallback = (request, _, _, errors) =>
                        errors == System.Net.Security.SslPolicyErrors.None ||
                        (request.RequestUri is Uri upstream && CanAcceptInvalidGatewayCertificate(configuration, upstream))
                };
            });
    }

    public static HttpClientHandler CreateLiteLlmHttpHandler(bool verifySsl, bool allowAutoRedirect) => new()
    {
        AllowAutoRedirect = allowAutoRedirect,
        ServerCertificateCustomValidationCallback = verifySsl
            ? null
            : HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
    };

    public static void AddApplicationGatewayHostServices(this WebApplicationBuilder builder)
    {
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.Logging.AddFilter("System.Net.Http.HttpClient", LogLevel.Warning);
        var connectionString = builder.Configuration.GetConnectionString("PostgreSql")
            ?? throw new InvalidOperationException("缺少 ConnectionStrings:PostgreSql");
        builder.Services.AddDbContext<AigcHubDbContext>(options => options.UseNpgsql(connectionString));
        builder.Services.AddHttpContextAccessor();
        builder.Services.AddScoped<ApplicationRouteService>();
        builder.Services.AddScoped<GatewaySettingsService>();
        builder.Services.AddScoped<LaunchTicketService>();
        builder.Services.AddScoped<GatewaySessionService>();
        AddGatewayUpstreamServices(builder.Services);
    }

    public static void UseAigcHubPipeline(this WebApplication app)
    {
        if (app.Configuration.GetValue("ApplicationGateway:HostEnabled", false))
            app.UseApplicationGateway();
        app.UseSwagger();
        app.UseSwaggerUI();
        app.UseCors();
        app.UseAuthentication();
        app.UseMiddleware<RequestLoggingMiddleware>();
        app.UseRateLimiter();
        app.UseAuthorization();
    }
}
