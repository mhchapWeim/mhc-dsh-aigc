using AigcHub.Api.Contracts;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class OrganizationEndpoints
{
    private static readonly SemaphoreSlim CategoryGate = new(1, 1);
    public static void MapOrganizationEndpoints(this IEndpointRouteBuilder app)
    {
        var departments = app.MapGroup("/api/departments").WithTags("部门管理")
            .RequireAuthorization("department.manage");
        departments.MapGet("/", ListDepartmentsAsync);
        departments.MapPost("/", CreateDepartmentAsync);
        departments.MapPut("/{id:guid}", UpdateDepartmentAsync);
        departments.MapDelete("/{id:guid}", DeleteDepartmentAsync);

        var categories = app.MapGroup("/api/categories").WithTags("分类管理")
            .RequireAuthorization("category.manage");
        categories.MapGet("/", ListCategoriesAsync);
        categories.MapPost("/", (SaveCategoryRequest input, AigcHubDbContext db, CancellationToken ct) =>
            MutateCategoryAsync(db, () => CreateCategoryAsync(input, db, ct), ct));
        categories.MapPut("/{id:guid}", (Guid id, SaveCategoryRequest input, AigcHubDbContext db, CancellationToken ct) =>
            MutateCategoryAsync(db, () => UpdateCategoryAsync(id, input, db, ct), ct));
        categories.MapDelete("/{id:guid}", (Guid id, AigcHubDbContext db, CancellationToken ct) =>
            MutateCategoryAsync(db, () => DeleteCategoryAsync(id, db, ct), ct));
    }

    private static async Task<IResult> MutateCategoryAsync(AigcHubDbContext db, Func<Task<IResult>> action, CancellationToken ct)
    {
        await CategoryGate.WaitAsync(ct);
        try
        {
            await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
            if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(72419310)", ct);
            var result = await action();
            if (tx is not null) await tx.CommitAsync(ct);
            return result;
        }
        finally { CategoryGate.Release(); }
    }

    private static async Task<IResult> ListDepartmentsAsync(int page, int pageSize,
        AigcHubDbContext db, CancellationToken ct)
    {
        (page, pageSize) = EndpointHelpers.NormalizePage(page, pageSize);
        var total = await db.Departments.CountAsync(ct);
        var items = await db.Departments.AsNoTracking().OrderBy(x => x.Name)
            .Skip((page - 1) * pageSize).Take(pageSize)
            .Select(x => new
            {
                x.Id, x.Code, x.Name, x.Description, x.ManagerId, x.IsEnabled,
                BillingPlanId = db.TokenBillingAssignments
                    .Where(a => a.SubjectType == "Department" && a.SubjectId == x.Id).Select(a => (Guid?)a.PlanId).FirstOrDefault()
            }).ToListAsync(ct);
        return Results.Ok(new PageResult<object>(items, page, pageSize, total));
    }

    private static async Task<IResult> DeleteDepartmentAsync(Guid id, ICurrentUser current, AigcHubDbContext db, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var department = await db.Departments.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (department is null) return Results.NotFound();
        if (await db.Users.AnyAsync(x => x.DepartmentId == id, ct))
            return Results.Conflict(new { message = "部门仍有用户，请先转移用户后再删除" });
        department.DeletedAt = DateTimeOffset.UtcNow;
        department.IsEnabled = false;
        db.TokenBillingAssignments.RemoveRange(await db.TokenBillingAssignments.Where(x => x.SubjectType == "Department" && x.SubjectId == id).ToArrayAsync(ct));
        db.OperationAudits.Add(new OperationAudit { UserId = current.Id, Action = "department.delete", EntityType = "Department", EntityId = id.ToString(), Succeeded = true });
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> CreateDepartmentAsync(SaveDepartmentRequest input,
        AigcHubDbContext db, TokenBillingService billing, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        if (await db.Departments.IgnoreQueryFilters().AnyAsync(x => x.Code == input.Code || x.Name == input.Name, ct))
            return Results.Conflict();
        var item = new Department
        {
            Code = input.Code.Trim(), Name = input.Name.Trim(), Description = input.Description.Trim(),
            ManagerId = input.ManagerId, IsEnabled = input.IsEnabled
        };
        db.Add(item);
        // Members inherit this plan unless their own binding overrides it.
        await billing.ApplyAsync("Department", item.Id, input.BillingPlanId, ct);
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
        return Results.Created($"/api/departments/{item.Id}", item);
    }

    private static async Task<IResult> UpdateDepartmentAsync(Guid id, SaveDepartmentRequest input,
        AigcHubDbContext db, TokenBillingService billing, CancellationToken ct)
    {
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        var item = await db.Departments.SingleOrDefaultAsync(x => x.Id == id, ct);
        if (item is null) return Results.NotFound();
        item.Code = input.Code.Trim();
        item.Name = input.Name.Trim();
        item.Description = input.Description.Trim();
        item.ManagerId = input.ManagerId;
        item.IsEnabled = input.IsEnabled;
        await billing.ApplyAsync("Department", item.Id, input.BillingPlanId, ct);
        await db.SaveChangesAsync(ct);
        await mutation.CommitAsync(ct);
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
        if (await db.Categories.AnyAsync(x => x.Code == (input.Code ?? "").Trim() || (x.Name == (input.Name ?? "").Trim() && x.ParentId == input.ParentId), ct))
            return Results.Conflict();
        await ValidateCategoryAsync(null, input, db, ct);
        var item = new AppCategory
        {
            Code = input.Code.Trim(), Name = input.Name.Trim(), Description = input.Description.Trim(),
            Color = input.Color, SortOrder = input.SortOrder, IsEnabled = input.IsEnabled, ParentId = input.ParentId
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
        await ValidateCategoryAsync(id, input, db, ct);
        item.ParentId = input.ParentId;
        item.Code = input.Code.Trim();
        item.Name = input.Name.Trim();
        item.Description = input.Description.Trim();
        item.Color = input.Color;
        item.SortOrder = input.SortOrder;
        item.IsEnabled = input.IsEnabled;
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task ValidateCategoryAsync(Guid? id, SaveCategoryRequest input, AigcHubDbContext db, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.Code)) throw new WorkflowException("请填写分类名称与编码");
        if (await db.Categories.AnyAsync(x => x.Id != id && (x.Code == input.Code.Trim() || (x.Name == input.Name.Trim() && x.ParentId == input.ParentId)), ct)) throw new WorkflowException("同级分类名称或分类编码已存在");
        if (input.ParentId is not null)
        {
            if (input.ParentId == id || !await db.Categories.AnyAsync(x => x.Id == input.ParentId && x.ParentId == null && x.IsEnabled, ct)) throw new WorkflowException("上级分类必须是已启用的一级分类");
            if (id is not null && await db.Categories.AnyAsync(x => x.ParentId == id, ct)) throw new WorkflowException("该分类含二级分类，不能移至其他分类下");
        }
    }

    private static async Task<IResult> DeleteCategoryAsync(Guid id, AigcHubDbContext db, CancellationToken ct)
    {
        var item = await db.Categories.FindAsync([id], ct);
        if (item is null) return Results.NotFound();
        if (await db.Categories.AnyAsync(x => x.ParentId == id, ct) || await db.RegisteredApplications.AnyAsync(x => x.CategoryId == id, ct) || await db.PublicationRequests.AnyAsync(x => x.CategoryId == id, ct))
            return Results.Conflict(new { message = "该分类仍有二级分类或关联应用，不能删除" });
        db.Categories.Remove(item);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }
}
