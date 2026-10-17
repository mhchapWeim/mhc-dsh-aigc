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
        app.MapRoleEndpoints();
        app.MapOrganizationEndpoints();
        app.MapProcessEndpoints();
        app.MapPublicationEndpoints();
        app.MapCatalogEndpoints();
        app.MapNotificationEndpoints();
        app.MapWorkflowCallbackEndpoints();
        app.MapChatEndpoints();
        app.MapModelEndpoints();
        app.MapVirtualKeyEndpoints();
        app.MapWebSearchEndpoints();
        app.MapPluginMarketEndpoints();
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
