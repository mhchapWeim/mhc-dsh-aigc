using AigcHub.Api.Configuration;
using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Gateway;

public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.AddApplicationGatewayHostServices();
        builder.Services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedFor;
            options.KnownNetworks.Clear();
            options.KnownProxies.Clear();
        });
        builder.Services.AddHostedService<GatewaySocketSweep>();
        var app = builder.Build();
        app.UseForwardedHeaders();
        app.UseWebSockets();
        app.UseMiddleware<RequestLoggingMiddleware>();
        app.UseApplicationGateway();
        app.MapGet("/health", () => Results.Ok(new { status = "Healthy", role = "application-gateway" })).AllowAnonymous();
        await app.RunAsync();
    }
}

/// <summary>
/// Closes upgraded connections after revoke, disable, unpublish or expiry.
/// New requests and WebSocket handshakes read the database immediately.
/// A socket already accepted on this replica is cancelled on the next sweep;
/// the forwarder activity timeout is also limited to the deadlines stored on that session.
/// </summary>
sealed class GatewaySocketSweep(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
                var now = DateTimeOffset.UtcNow;
                var valid = await db.ApplicationGatewaySessions.AsNoTracking()
                    .Where(x => x.ClosedAt == null && x.AbsoluteExpiresAt > now)
                    .Select(x => x.Id).ToListAsync(stoppingToken);
                ApplicationGatewayHost.CloseUnauthorized(valid);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }
    }
}
