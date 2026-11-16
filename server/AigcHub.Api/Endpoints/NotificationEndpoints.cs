using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class NotificationEndpoints
{
    public static void MapNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var notifications = app.MapGroup("/api/notifications").WithTags("站内信").RequireAuthorization();
        notifications.MapGet("/mine", ListMineAsync);
        notifications.MapGet("/unread", UnreadAsync);
        notifications.MapPost("/read-all", MarkAllReadAsync);
        notifications.MapPost("/{id:guid}/read", MarkReadAsync);
    }

    private static async Task<IResult> ListMineAsync(int page, int pageSize, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var query = db.Notifications.AsNoTracking().Where(x => x.UserId == current.Id);
        var total = await query.CountAsync(ct);
        var unread = await query.CountAsync(x => !x.IsRead, ct);
        var items = await query.OrderByDescending(x => x.CreatedAt).Skip((page - 1) * pageSize)
            .Take(pageSize).Select(x => new InboxNotificationView(x.Id, x.Title, x.Content, x.Link, x.IsRead, x.CreatedAt))
            .ToListAsync(ct);
        return Results.Ok(new NotificationPage(items, page, pageSize, total, unread));
    }

    /// <summary>
    /// The bell badge polls this endpoint, so it must stay cheap: only the count, never the message bodies.
    /// </summary>
    private static async Task<IResult> UnreadAsync(ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var query = db.Notifications.AsNoTracking().Where(x => x.UserId == current.Id);
        var unread = await query.CountAsync(x => !x.IsRead, ct);
        var latest = await query.Where(x => !x.IsRead).OrderByDescending(x => x.CreatedAt)
            .Select(x => new InboxNotificationView(x.Id, x.Title, x.Content, x.Link, x.IsRead, x.CreatedAt))
            .FirstOrDefaultAsync(ct);
        return Results.Ok(new { unread, latest });
    }

    private static async Task<IResult> MarkAllReadAsync(ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        var items = await db.Notifications.Where(x => x.UserId == current.Id && !x.IsRead).ToListAsync(ct);
        foreach (var item in items) item.IsRead = true;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> MarkReadAsync(Guid id, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.Notifications.SingleOrDefaultAsync(x => x.Id == id && x.UserId == current.Id, ct);
        if (item is null) return Results.NotFound();
        item.IsRead = true;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
