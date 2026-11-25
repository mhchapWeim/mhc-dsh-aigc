using AigcHub.Api.Services;

namespace AigcHub.Api.Endpoints;

public static class EndpointRouteBuilderExtensions
{
    public static void MapAigcHubEndpoints(this WebApplication app)
    {
        app.MapGet("/health", () => Results.Ok(new
        {
            status = "Healthy", database = "PostgreSQL", time = DateTimeOffset.UtcNow
        })).AllowAnonymous().WithTags("系统");

        app.MapAuthEndpoints();
        app.MapUserEndpoints();
        app.MapUserSyncEndpoints();
        app.MapRoleEndpoints();
        app.MapOrganizationEndpoints();
        app.MapProcessEndpoints();
        app.MapIntegrationEndpoints();
        app.MapPublicationEndpoints();
        app.MapApplicationPlatformEndpoints();
        app.MapCatalogEndpoints();
        app.MapApplicationRegistryEndpoints();
        app.MapNotificationEndpoints();
        app.MapWorkflowCallbackEndpoints();
        app.MapChatEndpoints();
        app.MapModelEndpoints();
        app.MapTokenBillingEndpoints();
        app.MapConfigSyncEndpoints();
        app.MapVirtualKeyEndpoints();
        app.MapWebSearchEndpoints();
        app.MapPluginMarketEndpoints();
        app.MapMcpMarketEndpoints();
        app.MapDshManagedEndpoints();
        app.MapDshUploadEndpoints();
        app.MapDshBackupEndpoints();
        app.MapSensitiveWordEndpoints();
        app.MapDesktopDistributionEndpoints();
        app.MapDesktopDownloadEndpoints();
        app.MapDshFailureEndpoints();
        app.MapDshFeedbackEndpoints();
        app.MapHub<NotificationHub>("/hubs/notifications");
    }
}
