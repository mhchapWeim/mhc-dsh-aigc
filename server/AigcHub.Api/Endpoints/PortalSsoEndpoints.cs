using System.Security.Cryptography;
using System.Text;
using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Endpoints;

public static class PortalSsoEndpoints
{
    public static void MapPortalSsoEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/auth/sso").WithTags("Bosch SSO").AllowAnonymous();
        group.MapGet("/config", (PortalSsoFlow flow) => Results.Ok(new { enabled = flow.Enabled }));
        group.MapGet("/start", (string? returnTo, HttpRequest request, HttpResponse response, PortalSsoFlow flow, IOptions<CasOptions> options) =>
        {
            NoStore(response);
            if (!flow.Enabled) return Results.Problem("Bosch SSO 尚未配置，请使用工号密码登录。", statusCode: 503);
            var pending = flow.Start(request, response, returnTo);
            return Results.Redirect(QueryHelpers.AddQueryString(options.Value.LoginUrl, "service", flow.Service(pending.State)));
        });
        group.MapPost("/complete", CompleteAsync);
    }

    public static async Task<IResult> CallbackAsync(string ticket, string state, HttpRequest request, HttpResponse response,
        PortalSsoFlow flow, CasAuthenticationService cas, AigcHubDbContext db, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        NoStore(response);
        if (!flow.Enabled) return Results.Problem("Bosch SSO 尚未配置。", statusCode: 503);
        var pending = flow.ReadPending(request);
        if (pending is null || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(pending.State), Encoding.UTF8.GetBytes(state)))
            return Results.Redirect(flow.LoginPage("expired"));
        var logger = loggerFactory.CreateLogger("PortalSsoAuthentication");
        try
        {
            var identity = await cas.ValidateAsync(ticket, flow.Service(pending.State), ct);
            if (identity is null) { PortalSsoFlow.Clear(response); return Results.Redirect(flow.LoginPage("failed", pending.ReturnTo)); }
            var user = await cas.FindOrCreateUserAsync(identity, ct);
            RequestLoggingMiddleware.Identify(request.HttpContext, user.Id, user.EmployeeNo, user.Name);
            if (!user.IsEnabled) { PortalSsoFlow.Clear(response); return Results.Redirect(flow.LoginPage("disabled", pending.ReturnTo)); }
            user.LastLoginAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            flow.Complete(request, response, user.Id);
            logger.LogInformation("Portal CAS login completed UserId={UserId} EmployeeNo={EmployeeNo} UserName={UserName}", user.Id, user.EmployeeNo, user.Name);
            return Results.Redirect(flow.LoginPage("complete", pending.ReturnTo));
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or InvalidOperationException or DbUpdateException)
        {
            PortalSsoFlow.Clear(response);
            // HttpRequestException messages may embed the CAS ticket URL; log a safe stage and stack instead.
            logger.LogWarning("Portal CAS login failed type={ErrorType} stack={ExceptionStack}", exception.GetType().Name, exception.StackTrace);
            return Results.Redirect(flow.LoginPage("failed", pending.ReturnTo));
        }
    }

    private static async Task<IResult> CompleteAsync(HttpRequest request, HttpResponse response, PortalSsoFlow flow,
        AigcHubDbContext db, TokenService tokens, CancellationToken ct)
    {
        NoStore(response);
        if (!flow.Enabled || !flow.AcceptsOrigin(request)) return Results.StatusCode(StatusCodes.Status403Forbidden);
        var completion = flow.ReadCompletion(request);
        PortalSsoFlow.Clear(response);
        if (completion is null) return Results.Unauthorized();
        var user = await db.Users.Include(x => x.Department).Include(x => x.Roles).ThenInclude(x => x.Role)
            .ThenInclude(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleOrDefaultAsync(x => x.Id == completion.UserId && x.IsEnabled, ct);
        return user is null ? Results.Unauthorized() : Results.Ok(tokens.Create(user,
            user.Roles.Select(x => x.Role.Name).ToArray(), user.Roles.SelectMany(x => x.Role.Permissions).Select(x => x.Permission.Code).Distinct().ToArray()));
    }
    private static void NoStore(HttpResponse response)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
