using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using System.Text.Json.Serialization;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Configuration;

public static class ApplicationConfiguration
{
    private static readonly string[] Permissions =
    [
        "portal.view", "admin.view", "publication.create", "publication.review", "process.design",
        "user.manage", "department.manage", "category.manage", "role.manage", "model.manage", "announcement.manage", "client-release.manage", "diagnostic.manage", "plugin.manage"
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
        builder.Services.Configure<ChatOptions>(builder.Configuration.GetSection("Chat"));
        builder.Services.Configure<LiteLlmOptions>(builder.Configuration.GetSection("LiteLlm"));
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>() ?? new JwtOptions();
        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
        {
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
        builder.Services.AddSingleton<CasDeviceLoginStore>();
        builder.Services.AddScoped<CasAuthenticationService>();
        builder.Services.AddScoped<PortalSsoFlow>();
        builder.Services.AddScoped<WorkflowDefinitionReader>();
        builder.Services.AddScoped<WorkflowService>();
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

    public static HttpClientHandler CreateLiteLlmHttpHandler(bool verifySsl, bool allowAutoRedirect) => new()
    {
        AllowAutoRedirect = allowAutoRedirect,
        ServerCertificateCustomValidationCallback = verifySsl
            ? null
            : HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
    };

    public static void UseAigcHubPipeline(this WebApplication app)
    {
        app.UseSwagger();
        app.UseSwaggerUI();
        app.UseCors();
        app.UseAuthentication();
        app.UseMiddleware<RequestLoggingMiddleware>();
        app.UseRateLimiter();
        app.UseAuthorization();
    }
}
