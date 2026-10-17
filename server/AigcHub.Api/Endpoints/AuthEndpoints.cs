using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class AuthEndpoints
{
    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPortalSsoEndpoints();
        var auth = app.MapGroup("/api/auth").WithTags("认证");
        auth.MapPost("/login", LoginAsync).AllowAnonymous();
        auth.MapGet("/me", ProfileAsync).RequireAuthorization();
    }

    private static async Task<IResult> LoginAsync(LoginRequest input, AigcHubDbContext db,
        IPasswordHasher<AppUser> hasher, TokenService tokens, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        var normalized = input.EmployeeNo.Trim().ToLowerInvariant();
        var user = await db.Users.Include(x => x.Department).Include(x => x.Roles)
            .ThenInclude(x => x.Role).ThenInclude(x => x.Permissions).ThenInclude(x => x.Permission)
            .SingleOrDefaultAsync(x => x.EmployeeNo.ToLower() == normalized && x.IsEnabled, ct);
        var logger = loggerFactory.CreateLogger("PortalAuthentication");
        if (user is null || hasher.VerifyHashedPassword(user, user.PasswordHash, input.Password) == PasswordVerificationResult.Failed)
        {
            logger.LogWarning("Password login rejected EmployeeNo={EmployeeNo}", normalized.Length > 64 ? normalized[..64] : normalized);
            return Results.Unauthorized();
        }

        user.LastLoginAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        logger.LogInformation("Password login completed UserId={UserId} EmployeeNo={EmployeeNo} UserName={UserName}", user.Id, user.EmployeeNo, user.Name);
        return Results.Ok(tokens.Create(user,
            user.Roles.Select(x => x.Role.Name).ToArray(),
            user.Roles.SelectMany(x => x.Role.Permissions).Select(x => x.Permission.Code).Distinct().ToArray()));
    }

    private static async Task<IResult> ProfileAsync(ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        await IdentityQueries.ProfileAsync(db, current.Id, ct) is { } profile
            ? Results.Ok(profile)
            : Results.Unauthorized();
}
