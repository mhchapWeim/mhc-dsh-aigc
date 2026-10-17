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
        notifications.MapPost("/{id:guid}/read", MarkReadAsync);
    }

    private static async Task<IResult> ListMineAsync(int page, int pageSize, ICurrentUser current,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var query = db.Notifications.AsNoTracking().Where(x => x.UserId == current.Id);
        var total = await query.CountAsync(ct);
        var items = await query.OrderByDescending(x => x.CreatedAt).Skip((page - 1) * pageSize)
            .Take(pageSize).ToListAsync(ct);
        return Results.Ok(new PageResult<InboxNotification>(items, page, pageSize, total));
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
