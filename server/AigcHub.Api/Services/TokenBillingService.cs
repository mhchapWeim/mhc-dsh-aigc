using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace AigcHub.Api.Services;

public sealed record TokenQuota(bool Assigned, string? PlanName, string Source, DateTimeOffset WeekStart,
    DateTimeOffset ResetsAt, long Total, long Used, long Reserved, long Remaining);
public sealed record TokenReservation(Guid RequestId, string ModelIdentifier, long RawTokenBudget);
public sealed record TokenSettlement(long InputTokens, long OutputTokens, long TotalTokens);

public sealed partial class TokenBillingService(AigcHubDbContext db, ModelConfigurationService models)
{
    // Serialize one quota mutation across this process and all PostgreSQL API replicas.
    private static readonly SemaphoreSlim Gate = new(1, 1);
    public static DateTimeOffset WeekStart(DateTimeOffset now)
    {
        var local = now.ToOffset(TimeSpan.FromHours(8));
        var days = ((int)local.DayOfWeek + 6) % 7;
        return new DateTimeOffset(local.Date.AddDays(-days), TimeSpan.FromHours(8)).ToUniversalTime();
    }
    public async Task<TokenQuota> QuotaAsync(Guid userId, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(x => x.Id == userId && x.IsEnabled, ct)
            ?? throw new WorkflowException("用户不存在或已停用", 403);
        return (await UserQuotasAsync([user.Id], ct))[user.Id];
    }

    // Batch the current list page, including disabled users for administration.
    public async Task<Dictionary<Guid, TokenQuota>> UserQuotasAsync(Guid[] userIds, CancellationToken ct)
    {
        var start = WeekStart(DateTimeOffset.UtcNow);
        var users = await db.Users.AsNoTracking().Where(x => userIds.Contains(x.Id))
            .Select(x => new { x.Id, x.DepartmentId }).ToArrayAsync(ct);
        var departmentIds = users.Where(x => x.DepartmentId.HasValue).Select(x => x.DepartmentId!.Value).Distinct().ToArray();
        var enabledDepartments = await db.Departments.AsNoTracking()
            .Where(x => departmentIds.Contains(x.Id) && x.IsEnabled).Select(x => x.Id).ToArrayAsync(ct);
        var assignments = await db.TokenBillingAssignments.AsNoTracking()
            .Where(x => (x.SubjectType == "User" && userIds.Contains(x.SubjectId))
                || (x.SubjectType == "Department" && enabledDepartments.Contains(x.SubjectId))).ToArrayAsync(ct);
        var planIds = assignments.Select(x => x.PlanId).Distinct().ToArray();
        var plans = await db.TokenBillingPlans.AsNoTracking().Where(x => planIds.Contains(x.Id)).ToDictionaryAsync(x => x.Id, ct);
        var usage = await db.TokenBillingEntries.AsNoTracking()
            .Where(x => userIds.Contains(x.UserId) && x.WeekStart == start).GroupBy(x => x.UserId)
            .Select(g => new { UserId = g.Key, Used = g.Sum(x => x.ChargedTokens),
                Reserved = g.Sum(x => x.Status == "Pending" ? x.ReservedTokens : 0) }).ToDictionaryAsync(x => x.UserId, ct);
        var extras = await db.TokenIncrementPackages.AsNoTracking()
            .Where(x => userIds.Contains(x.UserId) && x.WeekStart == start).GroupBy(x => x.UserId)
            .Select(g => new { UserId = g.Key, Tokens = g.Sum(x => x.Tokens) }).ToDictionaryAsync(x => x.UserId, ct);
        return users.ToDictionary(user => user.Id, user =>
        {
            var assignment = assignments.SingleOrDefault(x => x.SubjectType == "User" && x.SubjectId == user.Id);
            var source = assignment is null ? "Department" : "User";
            assignment ??= assignments.SingleOrDefault(x => x.SubjectType == "Department" && x.SubjectId == user.DepartmentId);
            var plan = assignment is not null ? plans.GetValueOrDefault(assignment.PlanId) : null;
            var used = usage.GetValueOrDefault(user.Id)?.Used ?? 0;
            var reserved = usage.GetValueOrDefault(user.Id)?.Reserved ?? 0;
            var total = plan?.IsEnabled == true ? checked(plan.WeeklyTokens + (extras.GetValueOrDefault(user.Id)?.Tokens ?? 0)) : 0;
            return new TokenQuota(plan?.IsEnabled == true, plan?.Name, plan is null ? "None" : source,
                start, start.AddDays(7), total, used, reserved, Math.Max(0, total - used));
        });
    }

    private async Task<T> Mutate<T>(Func<Task<T>> action, CancellationToken ct, bool mutationOwnsTransaction = false)
    {
        await Gate.WaitAsync(ct);
        IDbContextTransaction? transaction = null;
        try
        {
            if (db.Database.IsRelational())
            {
                if (!mutationOwnsTransaction) transaction = await db.Database.BeginTransactionAsync(ct);
                await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(736421010)", ct);
            }
            var result = await action();
            await db.SaveChangesAsync(ct);
            if (transaction is not null) await transaction.CommitAsync(ct);
            return result;
        }
        finally
        {
            if (transaction is not null) await transaction.DisposeAsync();
            Gate.Release();
        }
    }

    public async Task<TokenBillingEntry> ReserveAsync(Guid userId, TokenReservation input, CancellationToken ct)
    {
        if (input.RequestId == Guid.Empty || input.RawTokenBudget <= 0 || input.RawTokenBudget > 10_000_000)
            throw new WorkflowException("计费请求编号或 token 预算无效", 400);
        var available = await models.AvailableAsync(userId, ct);
        var model = available.SingleOrDefault(x => x.ProviderKind == "LiteLLM" && x.ModelIdentifier == input.ModelIdentifier)
            ?? throw new WorkflowException("外部模型未授权或已停用", 403);
        return await Mutate(async () =>
        {
            var old = await db.TokenBillingEntries.SingleOrDefaultAsync(x => x.Id == input.RequestId, ct);
            if (old is not null)
            {
                if (old.UserId != userId || old.ModelId != model.Id) throw new WorkflowException("计费请求编号冲突", 409);
                return old;
            }
            var quota = await QuotaAsync(userId, ct);
            if (!quota.Assigned) throw new WorkflowException("尚未分配周计费配方，外部模型不可用；内部模型不受影响", 402);
            const decimal factor = 1; // Model multiplier is display metadata only.
            const long reserve = 0;
            if (quota.Remaining <= 0) throw new WorkflowException("本周外部模型 tok 额度已用完，请选择内部模型或联系管理员", 402);
            var user = await db.Users.SingleAsync(x => x.Id == userId, ct);
            var department = await db.Departments.AsNoTracking().SingleOrDefaultAsync(x => x.Id == user.DepartmentId, ct);
            var assignment = await db.TokenBillingAssignments.AsNoTracking().SingleOrDefaultAsync(x => x.SubjectType == "User" && x.SubjectId == userId, ct)
                ?? await db.TokenBillingAssignments.AsNoTracking().SingleAsync(x => x.SubjectType == "Department" && x.SubjectId == user.DepartmentId, ct);
            var entry = new TokenBillingEntry { Id=input.RequestId,UserId=userId,DepartmentId=user.DepartmentId,
                EmployeeNo=user.EmployeeNo,UserName=user.Name,DepartmentName=department?.Name ?? "未分配部门",
                PlanId=assignment.PlanId,ModelId=model.Id,ModelName=model.Name,ModelIdentifier=model.ModelIdentifier,
                WeekStart=quota.WeekStart,Multiplier=factor,ReservedTokens=reserve };
            db.TokenBillingEntries.Add(entry);
            return entry;
        }, ct);
    }

    public Task<TokenBillingEntry> SettleAsync(Guid userId, Guid requestId, TokenSettlement usage, CancellationToken ct)
    {
        if (usage.InputTokens < 0 || usage.OutputTokens < 0 || usage.TotalTokens < 0
            || usage.TotalTokens > 10_000_000 || usage.TotalTokens < usage.InputTokens + usage.OutputTokens)
            throw new WorkflowException("实际 token 用量无效", 400);
        return Mutate(async () =>
        {
            var entry=await db.TokenBillingEntries.SingleOrDefaultAsync(x=>x.Id==requestId && x.UserId==userId,ct)
                ?? throw new WorkflowException("计费请求不存在",404);
            if(entry.Status=="Settled")
            {
                if(entry.InputTokens!=usage.InputTokens || entry.OutputTokens!=usage.OutputTokens || entry.TotalTokens!=usage.TotalTokens)
                    throw new WorkflowException("重复结算的 token 用量不一致",409);
                return entry;
            }
            if(entry.Status!="Pending") throw new WorkflowException("该计费请求不能再次结算",409);
            entry.InputTokens=usage.InputTokens;entry.OutputTokens=usage.OutputTokens;entry.TotalTokens=usage.TotalTokens;
            entry.Multiplier=1;entry.ChargedTokens=usage.TotalTokens;entry.Status="Settled";
            return entry;
        },ct);
    }

    public Task<bool> CancelAsync(Guid userId, Guid id, string reason, CancellationToken ct) => Mutate(async () =>
    {
        var entry=await db.TokenBillingEntries.SingleOrDefaultAsync(x=>x.Id==id && x.UserId==userId,ct)
            ?? throw new WorkflowException("计费请求不存在",404);
        if(entry.Status=="Pending") {entry.Status="Cancelled";entry.Note=reason[..Math.Min(reason.Length,200)];}
        return true;
    },ct);
}
