using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class CatalogEndpoints
{
    public static void MapCatalogEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/catalog/apps", async (ICurrentUser current, AigcHubDbContext db, CancellationToken ct) =>
        {
            var user = await db.Users.AsNoTracking().Include(x => x.Roles)
                .SingleOrDefaultAsync(x => x.Id == current.Id && x.IsEnabled, ct);
            if (user is null) return Results.Forbid();
            var roleIds = user.Roles.Select(x => x.RoleId).ToArray();
            var readyRoutes = await db.ApplicationRoutes.AsNoTracking().Where(x => x.Status == ApplicationRouteService.Ready)
                .ToDictionaryAsync(x => x.PublicationRequestId, x => x.Slug, ct);
            var readyIds = readyRoutes.Keys.ToArray();
            var personal = await db.ApplicationPersonalGrants.AsNoTracking()
                .Where(x => x.UserId == user.Id && x.RevokedAt == null && x.PublicationRequestId != null)
                .Select(x => x.PublicationRequestId!.Value).ToListAsync(ct);
            var items = await db.PublicationRequests.AsNoTracking()
                .Where(x => x.Status == PublicationStatus.Approved && x.OperationalEnabled && readyIds.Contains(x.Id) &&
                    (x.AccessMode == "All" || personal.Contains(x.Id) || x.AccessGrants.Any(grant =>
                        (grant.SubjectType == "User" && grant.SubjectId == user.Id) ||
                        (grant.SubjectType == "Department" && grant.SubjectId == user.DepartmentId) ||
                        (grant.SubjectType == "Role" && roleIds.Contains(grant.SubjectId)))))
                .Include(x => x.Category)
                .Include(x => x.Applicant).ThenInclude(x => x!.Department)
                .OrderByDescending(x => x.UpdatedAt)
                .Select(x => new
                {
                    x.Id,
                    Name = x.AppName,
                    Description = x.Summary,
                    Category = x.Category != null ? (x.Category.Parent != null ? x.Category.Parent.Name : x.Category.Name) : "未分类",
                    Subcategory = x.Category != null && x.Category.ParentId != null ? x.Category.Name : "",
                    SubcategoryId = x.Category != null && x.Category.ParentId != null ? (Guid?)x.CategoryId : null,
                    CategoryColor = x.Category != null ? x.Category.Color : "#2465d0",
                    Owner = x.Applicant != null && x.Applicant.Department != null
                        ? x.Applicant.Department.Name
                        : x.Applicant != null ? x.Applicant.Name : "平台运营",
                    AccessUrl = "",
                    Launchable = true,
                    PublishedAt = x.UpdatedAt,
                    ApplicationId = x.Id
                })
                .ToListAsync(ct);
            var published = items.Select(x => new
            {
                x.Id, x.Name, x.Description, x.Category, x.Subcategory, x.SubcategoryId, x.CategoryColor, x.Owner,
                x.AccessUrl, x.Launchable, Slug = readyRoutes[x.ApplicationId], x.PublishedAt
            });

            var registered = await db.RegisteredApplications.AsNoTracking().Include(x => x.Category).ThenInclude(x => x!.Parent)
                .Where(x => x.IsEnabled).OrderBy(x => x.SortOrder).ThenByDescending(x => x.CreatedAt).ToListAsync(ct);
            var counts = await ApplicationClickService.CountsAsync(db, registered.Select(x => x.Id).ToArray(), DateTimeOffset.UtcNow, ct);
            var totals = await ApplicationClickService.TotalsAsync(db, registered.Select(x => x.Id).ToArray(), ct);
            return Results.Ok(published.Cast<object>().Concat(registered.Select(x => (object)new
            {
                x.Id, x.Name, x.NameEn, x.Description, x.DescriptionEn, x.Owner, x.OwnerEn, x.CategoryEn,
                Category = x.Category?.Parent?.Name ?? x.Category?.Name ?? "未分类", Subcategory = x.Category?.ParentId != null ? x.Category.Name : "", SubcategoryId = x.Category?.ParentId != null ? (Guid?)x.CategoryId : null, Clicks = counts[x.Id], TotalClicks = totals[x.Id], CategoryColor = x.Category?.Color ?? "#2465d0",
                AccessUrl = "", PublishedAt = x.CreatedAt, Registered = true
            })));
        }).RequireAuthorization("portal.view").WithTags("应用目录");

        // Recently used: only applications this user actually launched, and only ones
        // they can still reach. Authorization is re-evaluated here rather than trusted
        // from the client's catalog, so a withdrawn grant drops out of the strip.
        app.MapGet("/api/catalog/recent-apps", async (ICurrentUser current, AigcHubDbContext db, int? limit, CancellationToken ct) =>
        {
            var user = await db.Users.AsNoTracking().Include(x => x.Roles).Include(x => x.Department)
                .SingleOrDefaultAsync(x => x.Id == current.Id && x.IsEnabled, ct);
            if (user is null) return Results.Forbid();
            var roleIds = user.Roles.Select(x => x.RoleId).ToArray();
            var ready = await db.ApplicationRoutes.AsNoTracking().Where(x => x.Status == ApplicationRouteService.Ready)
                .Select(x => x.PublicationRequestId).ToListAsync(ct);
            var personal = await db.ApplicationPersonalGrants.AsNoTracking()
                .Where(x => x.UserId == user.Id && x.RevokedAt == null && x.PublicationRequestId != null)
                .Select(x => x.PublicationRequestId!.Value).ToListAsync(ct);
            var published = await db.PublicationRequests.AsNoTracking()
                .Where(x => x.Status == PublicationStatus.Approved && x.OperationalEnabled && ready.Contains(x.Id) &&
                    (x.AccessMode == "All" || personal.Contains(x.Id) || x.AccessGrants.Any(grant =>
                        (grant.SubjectType == "User" && grant.SubjectId == user.Id) ||
                        (grant.SubjectType == "Department" && grant.SubjectId == user.DepartmentId) ||
                        (grant.SubjectType == "Role" && roleIds.Contains(grant.SubjectId)))))
                .Select(x => new { x.Id, Name = x.AppName })
                .ToListAsync(ct);
            var registered = await db.RegisteredApplications.AsNoTracking().Include(x => x.Grants)
                .Where(x => x.IsEnabled)
                .ToListAsync(ct);
            // Reuse the predicate the entry endpoint enforces, so a withdrawn grant
            // cannot linger in the strip as a dead shortcut.
            var registeredGrants = await RegisteredApplicationAccess.ActiveGrants(db, user.Id)
                .Select(x => x.RegisteredApplicationId!.Value).ToListAsync(ct);
            var reachable = registered.Where(x => RegisteredApplicationAccess.HasScope(x, user, registeredGrants.Contains(x.Id))).ToArray();
            var visible = published.Concat(reachable.Select(x => new { x.Id, Name = x.Name })).ToDictionary(x => x.Id, x => x.Name);
            var recent = await ApplicationClickService.RecentForUserAsync(db, user.Id, visible.Keys.ToArray(),
                limit ?? 6, ct);
            return Results.Ok(recent.Select(x => new
            {
                id = x.ApplicationId, name = visible[x.ApplicationId],
                // Registered applications resolve their URL on entry, so only published
                // ones carry one here; the client routes on this field.
                registered = reachable.Any(r => r.Id == x.ApplicationId),
                lastUsedAt = x.LastUsedAt,
            }));
        }).RequireAuthorization("portal.view").WithTags("应用目录");
    }
}
