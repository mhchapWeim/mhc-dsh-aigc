using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class OrganizationEndpoints
{
    public static void MapOrganizationEndpoints(this IEndpointRouteBuilder app)
    {
        var departments = app.MapGroup("/api/departments").WithTags("部门管理")
            .RequireAuthorization("department.manage");
        departments.MapGet("/", ListDepartmentsAsync);
        departments.MapPost("/", CreateDepartmentAsync);
        departments.MapPut("/{id:guid}", UpdateDepartmentAsync);

        var categories = app.MapGroup("/api/categories").WithTags("分类管理")
            .RequireAuthorization("category.manage");
        categories.MapGet("/", ListCategoriesAsync);
        categories.MapPost("/", CreateCategoryAsync);
        categories.MapPut("/{id:guid}", UpdateCategoryAsync);
        categories.MapDelete("/{id:guid}", DeleteCategoryAsync);
    }

    private static async Task<IResult> ListDepartmentsAsync(int page, int pageSize,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var total = await db.Departments.CountAsync(ct);
        var items = await db.Departments.AsNoTracking().OrderBy(x => x.Name)
            .Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        return Results.Ok(new PageResult<Department>(items, page, pageSize, total));
    }

    private static async Task<IResult> CreateDepartmentAsync(SaveDepartmentRequest input,
        AigcHubDbContext db, CancellationToken ct)
    {
        if (await db.Departments.AnyAsync(x => x.Code == input.Code || x.Name == input.Name, ct))
            return Results.Conflict();
        var item = new Department
        {
            Code = input.Code.Trim(), Name = input.Name.Trim(), Description = input.Description.Trim(),
            ManagerId = input.ManagerId, IsEnabled = input.IsEnabled
        };
        db.Add(item);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/departments/{item.Id}", item);
    }

    private static async Task<IResult> UpdateDepartmentAsync(Guid id, SaveDepartmentRequest input,
        AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.Departments.FindAsync([id], ct);
        if (item is null) return Results.NotFound();
        item.Code = input.Code.Trim();
        item.Name = input.Name.Trim();
        item.Description = input.Description.Trim();
        item.ManagerId = input.ManagerId;
        item.IsEnabled = input.IsEnabled;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ListCategoriesAsync(int page, int pageSize,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var total = await db.Categories.CountAsync(ct);
        var items = await db.Categories.AsNoTracking().OrderBy(x => x.SortOrder)
            .Skip((page - 1) * pageSize).Take(pageSize).ToListAsync(ct);
        return Results.Ok(new PageResult<AppCategory>(items, page, pageSize, total));
    }

    private static async Task<IResult> CreateCategoryAsync(SaveCategoryRequest input,
        AigcHubDbContext db, CancellationToken ct)
    {
        if (await db.Categories.AnyAsync(x => x.Code == input.Code || x.Name == input.Name, ct))
            return Results.Conflict();
        var item = new AppCategory
        {
            Code = input.Code.Trim(), Name = input.Name.Trim(), Description = input.Description.Trim(),
            Color = input.Color, SortOrder = input.SortOrder, IsEnabled = input.IsEnabled
        };
        db.Add(item);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/api/categories/{item.Id}", item);
    }

    private static async Task<IResult> UpdateCategoryAsync(Guid id, SaveCategoryRequest input,
        AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.Categories.FindAsync([id], ct);
        if (item is null) return Results.NotFound();
        item.Code = input.Code.Trim();
        item.Name = input.Name.Trim();
        item.Description = input.Description.Trim();
        item.Color = input.Color;
        item.SortOrder = input.SortOrder;
        item.IsEnabled = input.IsEnabled;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> DeleteCategoryAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.Categories.FindAsync([id], ct);
        if (item is null) return Results.NotFound();
        if (await db.PublicationRequests.AnyAsync(x => x.CategoryId == id, ct))
            return Results.Conflict(new { message = "该分类仍有关联的应用发布记录，不能删除" });
        db.Categories.Remove(item);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
