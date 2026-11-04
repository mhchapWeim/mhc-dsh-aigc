using AigcHub.Api.Data;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class TokenBillingEndpoints
{
    public sealed record PlanInput(string Name,long WeeklyTokens,bool IsEnabled=true,Guid[]? UserIds=null,Guid[]? DepartmentIds=null);
    public sealed record AssignmentInput(Guid? PlanId);
    public sealed record PackageInput(Guid UserId,long Tokens,string Reason);
    public sealed record CancelInput(string Reason);
    public static void MapTokenBillingEndpoints(this IEndpointRouteBuilder app)
    {
        // Self-service reads always use the authenticated identity, never a supplied user ID.
        app.MapGet("/api/billing/me", async (int? page, int? pageSize, ICurrentUser current,
            AigcHubDbContext db, TokenBillingService service, CancellationToken ct) =>
        {
            var quota = await service.QuotaAsync(current.Id, ct);
            var (number, size) = EndpointHelpers.NormalizePage(page ?? 1, pageSize ?? 10);
            var query = db.TokenIncrementPackages.AsNoTracking().Where(x => x.UserId == current.Id);
            var total = await query.CountAsync(ct);
            var items = await query.OrderByDescending(x => x.CreatedAt).ThenBy(x => x.Id)
                .Skip((number - 1) * size).Take(size)
                .Select(x => new { x.Id, x.Tokens, x.CreatedAt, x.ExpiresAt, x.Reason }).ToArrayAsync(ct);
            var extraTokens = await query.Where(x => x.WeekStart == quota.WeekStart).SumAsync(x => x.Tokens, ct);
            return Results.Ok(new { quota, extraTokens, checkedAt = DateTimeOffset.UtcNow,
                packages = new { items, total, page = number, pageSize = size } });
        }).RequireAuthorization();

        var admin=app.MapGroup("/api/billing").WithTags("周 token 计费").RequireAuthorization("model.manage");
        admin.MapGet("/",async(AigcHubDbContext db,CancellationToken ct)=>Results.Ok(new{
            plans=await db.TokenBillingPlans.AsNoTracking().OrderBy(x=>x.Name).ToArrayAsync(ct),
            assignments=await db.TokenBillingAssignments.AsNoTracking().ToArrayAsync(ct),
            users=await db.Users.AsNoTracking().OrderBy(x=>x.EmployeeNo).Select(x=>new{x.Id,x.Name,x.EmployeeNo,x.DepartmentId}).ToArrayAsync(ct),
            departments=await db.Departments.AsNoTracking().OrderBy(x=>x.Name).Select(x=>new{x.Id,x.Name}).ToArrayAsync(ct)
        }));
        app.MapPost("/api/billing/user-quotas", async (Guid[] userIds, TokenBillingService service, CancellationToken ct) =>
        {
            if (userIds.Length > 100) return Results.BadRequest(new { message = "每次最多查询 100 位用户" });
            return Results.Ok(await service.UserQuotasAsync(userIds.Distinct().ToArray(), ct));
        }).RequireAuthorization("user.manage");

        // User and department forms read the same catalog under their own permission, so an
        // organization editor never needs the billing-management grant just to pick a plan.
        app.MapGet("/api/billing/plan-options",async(AigcHubDbContext db,CancellationToken ct)=>
            Results.Ok(await db.TokenBillingPlans.AsNoTracking().OrderBy(x=>x.Name)
                .Select(x=>new{x.Id,x.Name,x.WeeklyTokens,x.IsEnabled}).ToArrayAsync(ct)))
            .WithTags("周 token 计费")
            .RequireAuthorization(policy=>policy.RequireAssertion(context=>
                context.User.HasClaim("permission","model.manage")
                || context.User.HasClaim("permission","user.manage")
                || context.User.HasClaim("permission","department.manage")));
        admin.MapPost("/packages",async(PackageInput input,ICurrentUser current,TokenBillingService service,CancellationToken ct)=>
            Results.Ok(await service.AddPackageAsync(input.UserId,input.Tokens,input.Reason,current.Id,ct)));
        admin.MapGet("/packages",async(int? page,int? pageSize,Guid? userId,string? keyword,AigcHubDbContext db,CancellationToken ct)=>
        {
            var (number,size)=EndpointHelpers.NormalizePage(page??1,pageSize??10);
            var query=db.TokenIncrementPackages.AsNoTracking().AsQueryable();
            if(userId.HasValue) query=query.Where(x=>x.UserId==userId);
            if(!string.IsNullOrWhiteSpace(keyword)) query=query.Where(x=>x.UserName.Contains(keyword)||x.EmployeeNo.Contains(keyword)||x.Reason.Contains(keyword));
            var total=await query.CountAsync(ct);
            var items=await query.OrderByDescending(x=>x.CreatedAt).ThenBy(x=>x.Id).Skip((number-1)*size).Take(size).ToArrayAsync(ct);
            return Results.Ok(new {items,total,page=number,pageSize=size});
        });
        admin.MapDelete("/plans/{id:guid}", async (Guid id, ICurrentUser current, TokenBillingService service, CancellationToken ct) =>
        {
            await service.DeletePlanAsync(id, current.Id, ct);
            return Results.NoContent();
        });
        admin.MapPost("/plans",async(PlanInput input,TokenBillingService service,CancellationToken ct)=>
            Results.Ok(await service.SavePlanAsync(null,input.Name,input.WeeklyTokens,input.IsEnabled,ct,input.UserIds,input.DepartmentIds)));
        admin.MapPut("/plans/{id:guid}",async(Guid id,PlanInput input,TokenBillingService service,CancellationToken ct)=>
            Results.Ok(await service.SavePlanAsync(id,input.Name,input.WeeklyTokens,input.IsEnabled,ct,input.UserIds,input.DepartmentIds)));
        admin.MapPut("/assignments/{type}/{subjectId:guid}",async(string type,Guid subjectId,AssignmentInput input,TokenBillingService service,CancellationToken ct)=>{
            await service.AssignAsync(type,subjectId,input.PlanId,ct);return Results.NoContent();});
        admin.MapGet("/report",async(DateTimeOffset? from,DateTimeOffset? to,Guid? userId,Guid? departmentId,TokenBillingService service,CancellationToken ct)=>
            Results.Ok(await service.ReportAsync(from,to,userId,departmentId,ct)));
        admin.MapPost("/pending/{id:guid}/release",async(Guid id,CancelInput input,AigcHubDbContext db,TokenBillingService service,CancellationToken ct)=>{
            if(string.IsNullOrWhiteSpace(input.Reason)) return Results.BadRequest(new{message="请先核对上游账单并填写释放原因"});
            var entry=await db.TokenBillingEntries.AsNoTracking().SingleOrDefaultAsync(x=>x.Id==id,ct);
            if(entry is null)return Results.NotFound();
            await service.CancelAsync(entry.UserId,id,input.Reason,ct);return Results.NoContent();});

        app.MapGet("/v1/billing/quota",async(HttpRequest request,AigcHubDbContext db,TokenBillingService service,CancellationToken ct)=>{
            var user=await DshManagedEndpoints.UserAsync(request,db,ct);
            return user is null?Results.Unauthorized():Results.Ok(await service.QuotaAsync(user.Id,ct));});
        app.MapPost("/v1/billing/reservations",async(HttpRequest request,TokenReservation input,AigcHubDbContext db,TokenBillingService service,CancellationToken ct)=>{
            var user=await DshManagedEndpoints.UserAsync(request,db,ct);
            if(user is null)return Results.Unauthorized();
            var entry=await service.ReserveAsync(user.Id,input,ct);
            return Results.Ok(new{entry.Id,entry.Status,entry.ReservedTokens,entry.Multiplier});});
        app.MapPut("/v1/billing/reservations/{id:guid}",async(Guid id,HttpRequest request,TokenSettlement input,AigcHubDbContext db,TokenBillingService service,CancellationToken ct)=>{
            var user=await DshManagedEndpoints.UserAsync(request,db,ct);
            if(user is null)return Results.Unauthorized();
            var entry=await service.SettleAsync(user.Id,id,input,ct);
            return Results.Ok(new{entry.Id,entry.Status,entry.ChargedTokens});});
    }
}
