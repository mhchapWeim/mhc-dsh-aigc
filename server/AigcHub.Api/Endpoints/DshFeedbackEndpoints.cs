using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class DshFeedbackEndpoints
{
    public sealed record Input(string SessionId, string? Category, string? Text, string SessionLog);
    private static readonly string[] Categories = ["task-result", "instruction-following", "product-interaction", "service-stability", "resource-cost", "security-privacy-permission", "other"];

    public static void MapDshFeedbackEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/v1/feedback", async (Input input, HttpRequest request, AigcHubDbContext db, CancellationToken ct) =>
        {
            var user = await DshManagedEndpoints.UserAsync(request, db, ct);
            if (user is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(input.SessionId) || input.SessionId.Length > 1024
                || (input.Text?.Length ?? 0) > 32000 || input.SessionLog is null || input.SessionLog.Length > 2_000_000
                || (input.Category is not null && !Categories.Contains(input.Category)))
                return Results.BadRequest(new { message = "反馈字段无效或内容过长" });
            var row = new DshFeedback { UserId = user.Id, SessionId = input.SessionId,
                Category = input.Category ?? "other", Text = input.Text?.Trim() ?? "",
                SessionLog = DshFailureEndpoints.Scrub(input.SessionLog) };
            db.DshFeedbacks.Add(row);
            await db.SaveChangesAsync(ct);
            return Results.Ok(new { id = row.Id });
        }).WithMetadata(new RequestSizeLimitAttribute(8 * 1024 * 1024));

        var admin = app.MapGroup("/api/dsh-feedback").RequireAuthorization("diagnostic.manage").WithTags("用户反馈");
        admin.MapGet("/", async (AigcHubDbContext db, CancellationToken ct, string? search = null, string? category = null, int page = 1, int pageSize = 5) =>
        {
            page = Math.Max(1, page);
            pageSize = Math.Clamp(pageSize, 1, 100);
        var query = db.DshFeedbacks.AsNoTracking();
            if (!string.IsNullOrWhiteSpace(search)) query = query.Where(x => x.Text.Contains(search) || x.User.Name.Contains(search) || x.User.EmployeeNo.Contains(search));
            if (!string.IsNullOrWhiteSpace(category)) query = query.Where(x => x.Category == category);
            var total = await query.CountAsync(ct);
            var items = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id).Skip((page - 1) * pageSize).Take(pageSize)
                .Select(x => new { x.Id, x.SessionId, x.Category, x.Text, x.CreatedAt, userName = x.User.Name, employeeNo = x.User.EmployeeNo }).ToListAsync(ct);
            return Results.Ok(new { items, total, page, pageSize });
        });
        admin.MapGet("/{id:guid}", async (Guid id, AigcHubDbContext db, CancellationToken ct) =>
        {
            var row = await db.DshFeedbacks.AsNoTracking().Where(x => x.Id == id)
                .Select(x => new { x.Id, x.SessionId, x.Category, x.Text, x.CreatedAt, x.SessionLog, userName = x.User.Name, employeeNo = x.User.EmployeeNo }).SingleOrDefaultAsync(ct);
            return row is null ? Results.NotFound() : Results.Ok(row);
        });
    }
}
