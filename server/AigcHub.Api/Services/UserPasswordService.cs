using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public static class UserPasswordService
{
    public static async Task ApplyAsync(AppUser user, string password, AigcHubDbContext db,
        IPasswordHasher<AppUser> hasher, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(password) || password.Length is < 8 or > 128)
            throw new WorkflowException("新密码长度必须为 8–128 个字符", 400);
        user.PasswordHash = hasher.HashPassword(user, password);
        // Password resets also invalidate issued desktop credentials and refresh sessions.
        db.DshAccessTokens.RemoveRange(await db.DshAccessTokens.Where(x => x.UserId == user.Id).ToArrayAsync(ct));
        foreach (var session in await db.DshPersistentSessions.Where(x => x.UserId == user.Id && !x.Revoked).ToArrayAsync(ct))
            session.Revoked = true;
    }
}
