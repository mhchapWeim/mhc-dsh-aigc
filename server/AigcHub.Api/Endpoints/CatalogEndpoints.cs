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
            var items = await db.PublicationRequests.AsNoTracking()
                .Where(x => x.Status == PublicationStatus.Approved && x.AccessUrl != "" &&
                    (x.AccessMode == "All" || x.AccessGrants.Any(grant =>
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
                    Category = x.Category != null ? x.Category.Name : "未分类",
                    CategoryColor = x.Category != null ? x.Category.Color : "#2465d0",
                    Owner = x.Applicant != null && x.Applicant.Department != null
                        ? x.Applicant.Department.Name
                        : x.Applicant != null ? x.Applicant.Name : "平台运营",
                    x.AccessUrl,
                    PublishedAt = x.UpdatedAt
                })
                .ToListAsync(ct);

            return Results.Ok(items);
        }).RequireAuthorization("portal.view").WithTags("应用目录");
    }
}
