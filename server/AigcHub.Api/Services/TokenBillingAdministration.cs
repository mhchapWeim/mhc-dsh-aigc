using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed partial class TokenBillingService
{
    public Task<TokenIncrementPackage> AddPackageAsync(Guid userId, long tokens, string reason, Guid? actor, CancellationToken ct)
    {
        if(tokens<=0 || tokens>1_000_000_000_000 || string.IsNullOrWhiteSpace(reason) || reason.Trim().Length>500)
            throw new WorkflowException("增量必须为1至1000000000000个token，并填写500字以内的原因",400);
        return Mutate(async()=>
        {
            var user=await db.Users.SingleOrDefaultAsync(x=>x.Id==userId && x.IsEnabled,ct)
                ?? throw new WorkflowException("用户不存在或已停用",404);
            var quota=await QuotaAsync(userId,ct);
            if(!quota.Assigned) throw new WorkflowException("请先为用户或其部门绑定启用的计费配方",409);
            if(quota.Total>1_000_000_000_000-tokens) throw new WorkflowException("本周期总额度不能超过1000000000000",400);
            var package=new TokenIncrementPackage {UserId=userId,UserName=user.Name,EmployeeNo=user.EmployeeNo,
                Tokens=tokens,WeekStart=quota.WeekStart,ExpiresAt=quota.ResetsAt,CreatedBy=actor,Reason=reason.Trim()};
            db.TokenIncrementPackages.Add(package);
            return package;
        },ct);
    }

    public async Task DeletePlanAsync(Guid id, Guid actor, CancellationToken ct)
    {
        // Organization/user edits use the grant lock; plan edits use the billing lock.
        // Taking both in this order closes the assignment-versus-delete race.
        await using var mutation = await VirtualKeyGrantRules.BeginMutationAsync(db, ct);
        await Mutate(async () =>
        {
            var plan = await db.TokenBillingPlans.SingleOrDefaultAsync(x => x.Id == id, ct)
                ?? throw new WorkflowException("计费配方不存在", 404);
            if (await db.TokenBillingAssignments.AnyAsync(x => x.PlanId == id, ct))
                throw new WorkflowException("配方正在使用，请先解除个人和部门绑定", 409);
            plan.DeletedAt = DateTimeOffset.UtcNow;
            plan.IsEnabled = false;
            db.OperationAudits.Add(new OperationAudit { UserId = actor, Action = "billing-plan.delete", EntityType = "TokenBillingPlan", EntityId = id.ToString(), Succeeded = true });
            return true;
        }, ct, mutationOwnsTransaction: true);
        await mutation.CommitAsync(ct);
    }

    public Task<TokenBillingPlan> SavePlanAsync(Guid? id, string name, long weeklyTokens, bool enabled, CancellationToken ct, Guid[]? userIds = null, Guid[]? departmentIds = null)
    {
        if(string.IsNullOrWhiteSpace(name)||name.Trim().Length>80||weeklyTokens<=0||weeklyTokens>1_000_000_000_000)
            throw new WorkflowException("配方名称或周 token 额度无效",400);
        return Mutate(async()=>
        {
            var plan=id.HasValue ? await db.TokenBillingPlans.SingleOrDefaultAsync(x=>x.Id==id,ct)
                ?? throw new WorkflowException("计费配方不存在",404) : new TokenBillingPlan();
            if(await db.TokenBillingPlans.IgnoreQueryFilters().AnyAsync(x=>x.Name==name.Trim()&&x.Id!=plan.Id,ct)) throw new WorkflowException("配方名称已存在",409);
            // Validate both selections before changing the plan or its assignments.
            var users=userIds?.Distinct().ToArray();
            var departments=departmentIds?.Distinct().ToArray();
            if(users is not null && await db.Users.CountAsync(x=>users.Contains(x.Id),ct)!=users.Length)
                throw new WorkflowException("授权用户不存在",404);
            if(departments is not null && await db.Departments.CountAsync(x=>departments.Contains(x.Id),ct)!=departments.Length)
                throw new WorkflowException("授权部门不存在",404);
            plan.Name=name.Trim();plan.WeeklyTokens=weeklyTokens;plan.IsEnabled=enabled;
            if(!id.HasValue) db.TokenBillingPlans.Add(plan);
            foreach(var selection in new[] { (Type:"User",Ids:users), (Type:"Department",Ids:departments) })
            {
                if(selection.Ids is null) continue;
                var bindings=await db.TokenBillingAssignments.Where(x=>x.SubjectType==selection.Type).ToListAsync(ct);
                db.TokenBillingAssignments.RemoveRange(bindings.Where(x=>x.PlanId==plan.Id&&!selection.Ids.Contains(x.SubjectId)));
                foreach(var subjectId in selection.Ids)
                {
                    var binding=bindings.SingleOrDefault(x=>x.SubjectId==subjectId);
                    if(binding is null) db.TokenBillingAssignments.Add(new TokenBillingAssignment {SubjectType=selection.Type,SubjectId=subjectId,PlanId=plan.Id});
                    else binding.PlanId=plan.Id;
                }
            }
            return plan;
        },ct);
    }
    public Task<bool> AssignAsync(string type, Guid subjectId, Guid? planId, CancellationToken ct)
    {
        if(type!="User"&&type!="Department") throw new WorkflowException("配方只能分配给个人或部门",400);
        return Mutate(async()=>
        {
            var exists=type=="User" ? await db.Users.AnyAsync(x=>x.Id==subjectId,ct) : await db.Departments.AnyAsync(x=>x.Id==subjectId,ct);
            if(!exists) throw new WorkflowException("分配对象不存在",404);
            await ApplyAsync(type,subjectId,planId,ct);
            return true;
        },ct);
    }

    /// <summary>
    /// Upsert or clear one assignment inside the caller's transaction, so an organization
    /// edit and its quota binding commit together. A null plan means "no direct binding",
    /// which lets a user fall back to the department plan.
    /// </summary>
    public async Task ApplyAsync(string type, Guid subjectId, Guid? planId, CancellationToken ct)
    {
        if(planId.HasValue&&!await db.TokenBillingPlans.AnyAsync(x=>x.Id==planId,ct)) throw new WorkflowException("计费配方不存在",404);
        var current=await db.TokenBillingAssignments.SingleOrDefaultAsync(x=>x.SubjectType==type&&x.SubjectId==subjectId,ct);
        if(!planId.HasValue) {if(current is not null) db.TokenBillingAssignments.Remove(current);}
        else if(current is null) db.TokenBillingAssignments.Add(new TokenBillingAssignment {SubjectType=type,SubjectId=subjectId,PlanId=planId.Value});
        else current.PlanId=planId.Value;
    }

    /// <summary>Read the plan bound to exactly this subject, without department fallback.</summary>
    public Task<Guid?> DirectPlanAsync(string type, Guid subjectId, CancellationToken ct) =>
        db.TokenBillingAssignments.AsNoTracking()
            .Where(x=>x.SubjectType==type&&x.SubjectId==subjectId)
            .Select(x=>(Guid?)x.PlanId).SingleOrDefaultAsync(ct);

    public async Task<object> ReportAsync(DateTimeOffset? from, DateTimeOffset? to, Guid? userId, Guid? departmentId, CancellationToken ct)
    {
        var start=from??WeekStart(DateTimeOffset.UtcNow);var end=to??start.AddDays(7);
        if(end<=start||end-start>TimeSpan.FromDays(93)) throw new WorkflowException("报表时间范围必须在93天内",400);
        var query=db.TokenBillingEntries.AsNoTracking().Where(x=>x.CreatedAt>=start&&x.CreatedAt<end);
        if(userId.HasValue) query=query.Where(x=>x.UserId==userId);
        if(departmentId.HasValue) query=query.Where(x=>x.DepartmentId==departmentId);
        var entries=await query.ToArrayAsync(ct);
        var settled=entries.Where(x=>x.Status=="Settled").ToArray();
        // Trend buckets follow the same Asia/Shanghai week boundary the quota uses, so a
        // chart point and the weekly total agree at midnight.
        var offset=TimeSpan.FromHours(8);
        var buckets=settled.GroupBy(x=>DateOnly.FromDateTime(x.CreatedAt.ToOffset(offset).DateTime))
            .ToDictionary(g=>g.Key,g=>g.ToArray());
        var trend=new List<object>();
        for(var day=DateOnly.FromDateTime(start.ToOffset(offset).DateTime);day<DateOnly.FromDateTime(end.ToOffset(offset).DateTime);day=day.AddDays(1))
        {
            var bucket=buckets.GetValueOrDefault(day)??[];
            trend.Add(new{date=day.ToString("yyyy-MM-dd"),totalTokens=bucket.Sum(x=>x.TotalTokens),
                chargedTokens=bucket.Sum(x=>x.ChargedTokens),requests=bucket.Length});
        }
        return new {
            from=start,to=end,
            trend,
            byUser=settled.GroupBy(x=>new{x.UserId,x.EmployeeNo,x.UserName,x.DepartmentId,x.DepartmentName})
                .Select(g=>new{g.Key.UserId,g.Key.EmployeeNo,g.Key.UserName,g.Key.DepartmentId,g.Key.DepartmentName,
                    inputTokens=g.Sum(x=>x.InputTokens),outputTokens=g.Sum(x=>x.OutputTokens),totalTokens=g.Sum(x=>x.TotalTokens),chargedTokens=g.Sum(x=>x.ChargedTokens),requests=g.Count()}),
            byDepartment=settled.GroupBy(x=>new{x.DepartmentId,x.DepartmentName}).Select(g=>new{g.Key.DepartmentId,g.Key.DepartmentName,
                totalTokens=g.Sum(x=>x.TotalTokens),chargedTokens=g.Sum(x=>x.ChargedTokens),requests=g.Count()}),
            byModel=settled.GroupBy(x=>new{x.ModelId,x.ModelName,x.ModelIdentifier}).Select(g=>new{g.Key.ModelId,g.Key.ModelName,g.Key.ModelIdentifier,
                inputTokens=g.Sum(x=>x.InputTokens),outputTokens=g.Sum(x=>x.OutputTokens),totalTokens=g.Sum(x=>x.TotalTokens),chargedTokens=g.Sum(x=>x.ChargedTokens),requests=g.Count()}),
            pending=entries.Where(x=>x.Status=="Pending").Select(x=>new{x.Id,x.UserId,x.UserName,x.DepartmentName,x.ModelName,x.ReservedTokens,x.CreatedAt}),
            totals=new{totalTokens=settled.Sum(x=>x.TotalTokens),chargedTokens=settled.Sum(x=>x.ChargedTokens),requests=settled.Length}
        };
    }
}
