using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using System.Text;

namespace AigcHub.Api.Endpoints;

public static class SensitiveWordEndpoints
{
    private sealed record SaveSensitiveWordRequest(string Term, bool IsEnabled = true);

    public static void MapSensitiveWordEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/sensitive-words").WithTags("敏感词管理").RequireAuthorization("model.manage");
        admin.MapGet("/", AdminListAsync);
        admin.MapPost("/", CreateAsync);
        admin.MapPut("/{id:guid}", UpdateAsync);
        admin.MapDelete("/{id:guid}", DeleteAsync);

        app.MapGet("/v1/sensitive-words", CatalogAsync).WithTags("DSH 托管接入");
    }

    private static async Task<IResult> AdminListAsync(AigcHubDbContext db, CancellationToken ct) =>
        Results.Ok(await db.SensitiveWords.AsNoTracking().OrderByDescending(x => x.UpdatedAt)
            .Select(x => new { x.Id, x.Term, x.IsEnabled, x.CreatedAt, x.UpdatedAt }).ToArrayAsync(ct));

    private static async Task<IResult> CreateAsync(SaveSensitiveWordRequest input, AigcHubDbContext db, CancellationToken ct)
    {
        var parsed = Parse(input.Term);
        if (parsed is null) return Results.BadRequest(new { error = "敏感词长度必须为 1 到 200 个字符" });
        if (await db.SensitiveWords.AnyAsync(x => x.NormalizedTerm == parsed.Value.Normalized, ct))
            return Results.Conflict(new { error = "该敏感词已存在" });
        var item = new SensitiveWord { Term = parsed.Value.Term, NormalizedTerm = parsed.Value.Normalized, IsEnabled = input.IsEnabled };
        db.SensitiveWords.Add(item);
        await db.SaveChangesAsync(ct);
        return Results.Ok(View(item));
    }

    private static async Task<IResult> UpdateAsync(Guid id, SaveSensitiveWordRequest input, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.SensitiveWords.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (item is null) return Results.NotFound();
        var parsed = Parse(input.Term);
        if (parsed is null) return Results.BadRequest(new { error = "敏感词长度必须为 1 到 200 个字符" });
        if (await db.SensitiveWords.AnyAsync(x => x.Id != id && x.NormalizedTerm == parsed.Value.Normalized, ct))
            return Results.Conflict(new { error = "该敏感词已存在" });
        item.Term = parsed.Value.Term;
        item.NormalizedTerm = parsed.Value.Normalized;
        item.IsEnabled = input.IsEnabled;
        item.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return Results.Ok(View(item));
    }

    private static async Task<IResult> DeleteAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var deleted = await db.SensitiveWords.Where(x => x.Id == id).ExecuteDeleteAsync(ct);
        return deleted == 0 ? Results.NotFound() : Results.NoContent();
    }

    private static async Task<IResult> CatalogAsync(HttpRequest request, AigcHubDbContext db, CancellationToken ct)
    {
        if (await DshManagedEndpoints.UserAsync(request, db, ct) is null) return Results.Unauthorized();
        var active = await db.SensitiveWords.AsNoTracking().Where(x => x.IsEnabled)
            .OrderBy(x => x.NormalizedTerm).Select(x => new { x.Term, x.UpdatedAt }).ToArrayAsync(ct);
        var revision = active.Length == 0 ? "0" : active.Max(x => x.UpdatedAt).ToUnixTimeMilliseconds().ToString();
        return Results.Ok(new { revision, words = active.SelectMany(x => x.Term.Split(
            ['，', ',', '、', '；', ';', '\r', '\n'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray() });
    }

    private static (string Term, string Normalized)? Parse(string? value)
    {
        var term = value?.Trim();
        if (string.IsNullOrEmpty(term) || term.Length > 200) return null;
        return (term, term.Normalize(NormalizationForm.FormKC).ToLowerInvariant());
    }

    private static object View(SensitiveWord item) => new
    {
        item.Id, item.Term, item.IsEnabled, item.CreatedAt, item.UpdatedAt
    };
}
