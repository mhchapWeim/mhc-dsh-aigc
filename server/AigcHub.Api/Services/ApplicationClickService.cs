using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

public sealed record ApplicationClickCounts(long Day = 0, long Week = 0, long Month = 0, long Year = 0);

/// <summary>
/// Requested display values. <paramref name="Total"/> sets the lifetime figure directly;
/// the four windows only shift their own period, as before.
/// </summary>
public sealed record ApplicationClickUpdate(long? Day = null, long? Week = null, long? Month = null, long? Year = null, long? Total = null);
public sealed record ClickTrendPoint(string Date, long Clicks);
public sealed record ClickHistory(string From, string To, IReadOnlyList<ClickTrendPoint> Trend, Dictionary<Guid, long> ByApplication);
public sealed record ClickDayBucket(DateOnly Date, long Clicks);

public static class ApplicationClickService
{
    public static async Task<ClickHistory> HistoryAsync(AigcHubDbContext db, Guid[] ids, string? from, string? to, DateTimeOffset now, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(now.ToOffset(TimeSpan.FromHours(8)).Date);
        DateOnly Parse(string? value, DateOnly fallback) => string.IsNullOrEmpty(value) ? fallback
            : DateOnly.TryParseExact(value, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var date)
                ? date : throw new WorkflowException("日期格式须为 yyyy-MM-dd");
        var end = Parse(to, today.AddDays(1));
        if (end.DayNumber < 31) throw new WorkflowException("请选择有效的统计日期");
        var start = Parse(from, end.AddDays(-30));
        var days = end.DayNumber - start.DayNumber;
        if (days is <= 0 or > 366 || start == DateOnly.MinValue) throw new WorkflowException("请选择 1 至 366 天的统计区间，结束日期不包含在内");
        DateTimeOffset Utc(DateOnly date) => new DateTimeOffset(date.ToDateTime(TimeOnly.MinValue), TimeSpan.FromHours(8)).ToUniversalTime();
        var startAt = Utc(start); var endAt = Utc(end);
        var query = db.ApplicationClicks.AsNoTracking().Where(x => ids.Contains(x.ApplicationId) && x.CreatedAt >= startAt && x.CreatedAt < endAt && x.CreatedAt <= now);
        // Explicit timezone conversion also avoids dependence on the database connection's session timezone.
        List<ClickDayBucket> daily;
        if (db.Database.IsNpgsql())
            daily = await db.Database.SqlQuery<ClickDayBucket>($"""
                SELECT ("CreatedAt" AT TIME ZONE 'Asia/Shanghai')::date AS "Date", count(*) AS "Clicks"
                FROM aigc_hub."ApplicationClicks"
                WHERE "ApplicationId" = ANY({ids}) AND "CreatedAt" >= {startAt} AND "CreatedAt" < {endAt} AND "CreatedAt" <= {now}
                GROUP BY 1
                """).ToListAsync(ct);
        else
            daily = await query.GroupBy(x => DateOnly.FromDateTime(x.CreatedAt.UtcDateTime.AddHours(8)))
                .Select(g => new ClickDayBucket(g.Key, g.LongCount())).ToListAsync(ct);
        var byDate = daily.ToDictionary(x => x.Date, x => x.Clicks);
        var byApp = await query.GroupBy(x => x.ApplicationId).Select(g => new { Id = g.Key, Clicks = g.LongCount() })
            .ToDictionaryAsync(x => x.Id, x => x.Clicks, ct);
        var trend = Enumerable.Range(0, days).Select(index => start.AddDays(index))
            .Select(date => new ClickTrendPoint(date.ToString("yyyy-MM-dd"), byDate.GetValueOrDefault(date))).ToArray();
        return new(start.ToString("yyyy-MM-dd"), end.ToString("yyyy-MM-dd"), trend, byApp);
    }

    // Serialize writes across API replicas with a transaction advisory lock; the gate also covers in-memory tests.
    private static readonly SemaphoreSlim[] Gates = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1)).ToArray();
    public static async Task<T> MutateAsync<T>(AigcHubDbContext db, Guid applicationId, Func<Task<T>> action, CancellationToken ct)
    {
        // Guid bytes are stable across processes. Fixed stripes bound memory without a growing per-user lock map.
        var lockKey = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(System.Security.Cryptography.SHA256.HashData(applicationId.ToByteArray()));
        var gate = Gates[(int)((uint)lockKey % Gates.Length)];
        await gate.WaitAsync(ct);
        try
        {
            await using var tx = db.Database.IsRelational() ? await db.Database.BeginTransactionAsync(ct) : null;
            if (db.Database.IsNpgsql()) await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(72419309, {lockKey})", ct);
            var result = await action();
            await db.SaveChangesAsync(ct);
            if (tx is not null) await tx.CommitAsync(ct);
            return result;
        }
        finally { gate.Release(); }
    }

    public static Dictionary<string, DateTimeOffset> Periods(DateTimeOffset now)
    {
        var date = now.ToOffset(TimeSpan.FromHours(8)).Date;
        DateTimeOffset Utc(DateTime d) => new DateTimeOffset(d, TimeSpan.FromHours(8)).ToUniversalTime();
        return new() {
            ["day"] = Utc(date), ["week"] = Utc(date.AddDays(-(((int)date.DayOfWeek + 6) % 7))),
            ["month"] = Utc(new(date.Year, date.Month, 1)), ["year"] = Utc(new(date.Year, 1, 1))
        };
    }

    public static async Task<Dictionary<Guid, ApplicationClickCounts>> CountsAsync(AigcHubDbContext db, Guid[] ids, DateTimeOffset now, CancellationToken ct)
    {
        await using var snapshot = db.Database.IsRelational() && db.Database.CurrentTransaction is null
            ? await db.Database.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead, ct) : null;
        var periods = Periods(now);
        var values = new Dictionary<string, Dictionary<Guid, long>>();
        foreach (var (period, start) in periods)
        {
            var raw = await db.ApplicationClicks.AsNoTracking().Where(x => ids.Contains(x.ApplicationId) && x.CreatedAt >= start && x.CreatedAt <= now)
                .GroupBy(x => x.ApplicationId).Select(g => new { Id = g.Key, Count = g.LongCount() }).ToDictionaryAsync(x => x.Id, x => x.Count, ct);
            var adjustments = await db.ApplicationClickAdjustments.AsNoTracking().Where(x => ids.Contains(x.ApplicationId) && x.Period == period && x.PeriodStart == start).ToListAsync(ct);
            foreach (var adjustment in adjustments) raw[adjustment.ApplicationId] = Math.Max(0, raw.GetValueOrDefault(adjustment.ApplicationId) + adjustment.Offset);
            values[period] = raw;
        }
        var result = ids.ToDictionary(id => id, id => new ApplicationClickCounts(values["day"].GetValueOrDefault(id), values["week"].GetValueOrDefault(id), values["month"].GetValueOrDefault(id), values["year"].GetValueOrDefault(id)));
        if (snapshot is not null) await snapshot.CommitAsync(ct);
        return result;
    }

    public static async Task<bool> RecordAsync(AigcHubDbContext db, Guid applicationId, Guid userId, Guid visitId, CancellationToken ct)
    {
        if (visitId == Guid.Empty) throw new WorkflowException("缺少点击标识");
        // One successful authorized launch per user/application in a three-second window, across tabs and replicas.
        var now = DateTimeOffset.UtcNow;
        if (await db.ApplicationClicks.AnyAsync(x => x.ApplicationId == applicationId && x.UserId == userId && (x.VisitId == visitId || x.CreatedAt > now.AddSeconds(-3)), ct)) return false;
        db.ApplicationClicks.Add(new() { VisitId = visitId, ApplicationId = applicationId, UserId = userId, CreatedAt = now });
        return true;
    }

    /// <summary>Adjustment row key for the lifetime figure; no calendar window produces it.</summary>
    private const string TotalPeriod = "total";
    private static readonly DateTimeOffset TotalStart = DateTimeOffset.UnixEpoch;

    /// <summary>
    /// Lifetime clicks per application, for the portal card. The reporting windows in
    /// <see cref="CountsAsync"/> stay untouched; this is a separate, unbounded total.
    /// Only the lifetime row applies here: the per-period offsets belong to their own
    /// windows, so editing 日点击 never moves the card's total.
    /// </summary>
    public static async Task<Dictionary<Guid, long>> TotalsAsync(AigcHubDbContext db, Guid[] ids, CancellationToken ct)
    {
        if (ids.Length == 0) return [];
        var raw = await db.ApplicationClicks.AsNoTracking().Where(x => ids.Contains(x.ApplicationId))
            .GroupBy(x => x.ApplicationId).Select(g => new { Id = g.Key, Count = g.LongCount() })
            .ToDictionaryAsync(x => x.Id, x => x.Count, ct);
        var offsets = await db.ApplicationClickAdjustments.AsNoTracking()
            .Where(x => ids.Contains(x.ApplicationId) && x.Period == TotalPeriod && x.PeriodStart == TotalStart)
            .ToDictionaryAsync(x => x.ApplicationId, x => x.Offset, ct);
        return ids.ToDictionary(id => id, id => Math.Max(0, raw.GetValueOrDefault(id) + offsets.GetValueOrDefault(id)));
    }

    /// <summary>One application this user opened, newest first.</summary>
    public sealed record RecentApplication(Guid ApplicationId, DateTimeOffset LastUsedAt);

    /// <summary>
    /// The applications this user actually launched, most recent first. Display counts
    /// keep their manual adjustments; recency comes only from real click rows.
    /// </summary>
    public static async Task<IReadOnlyList<RecentApplication>> RecentForUserAsync(AigcHubDbContext db, Guid userId,
        Guid[] candidates, int limit, CancellationToken ct)
    {
        if (candidates.Length == 0) return [];
        // Project to an anonymous shape first: the in-memory provider cannot translate a
        // grouped projection straight into a record constructor.
        var rows = await db.ApplicationClicks.AsNoTracking()
            .Where(x => x.UserId == userId && candidates.Contains(x.ApplicationId))
            .GroupBy(x => x.ApplicationId)
            .Select(g => new { ApplicationId = g.Key, LastUsedAt = g.Max(x => x.CreatedAt) })
            .OrderByDescending(x => x.LastUsedAt)
            .Take(Math.Clamp(limit, 1, 20))
            .ToListAsync(ct);
        return rows.Select(x => new RecentApplication(x.ApplicationId, x.LastUsedAt)).ToArray();
    }

    public static async Task AdjustAsync(AigcHubDbContext db, Guid id, Guid actor, ApplicationClickUpdate desired, CancellationToken ct)
    {
        const long max = 1_000_000_000_000;
        var requested = new Dictionary<string, long?> { ["day"] = desired.Day, ["week"] = desired.Week, ["month"] = desired.Month, ["year"] = desired.Year };
        if (requested.Values.Append(desired.Total).Any(x => x < 0 || x > max)) throw new WorkflowException("点击数须为 0 至 1000000000000 的整数");
        var now = DateTimeOffset.UtcNow;
        var before = (await CountsAsync(db, [id], now, ct))[id];
        var beforeTotal = (await TotalsAsync(db, [id], ct))[id];
        foreach (var (period, start) in Periods(now))
        {
            if (requested[period] is not long value) continue;
            var raw = await db.ApplicationClicks.LongCountAsync(x => x.ApplicationId == id && x.CreatedAt >= start && x.CreatedAt <= now, ct);
            var item = await db.ApplicationClickAdjustments.FindAsync([id, period, start], ct);
            if (item is null) { item = new() { ApplicationId = id, Period = period, PeriodStart = start }; db.ApplicationClickAdjustments.Add(item); }
            item.Offset = value - raw;
        }
        // The lifetime figure is its own row, keyed by a period no calendar window uses.
        // Without it, editing 日点击 would silently move the card's total too.
        if (desired.Total is long total)
        {
            var raw = await db.ApplicationClicks.LongCountAsync(x => x.ApplicationId == id, ct);
            var item = await db.ApplicationClickAdjustments.FindAsync([id, TotalPeriod, TotalStart], ct);
            if (item is null) { item = new() { ApplicationId = id, Period = TotalPeriod, PeriodStart = TotalStart }; db.ApplicationClickAdjustments.Add(item); }
            item.Offset = total - raw;
        }
        db.OperationAudits.Add(new() { UserId = actor, Action = "application.clicks.adjust", EntityType = "RegisteredApplication", EntityId = id.ToString(), Succeeded = true,
            DetailJson = JsonSerializer.Serialize(new { Before = before, BeforeTotal = beforeTotal, After = desired, Periods = Periods(now) }) });
    }
}
