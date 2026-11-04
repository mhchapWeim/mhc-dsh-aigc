using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace AigcHub.Tests;

public sealed class ApplicationAnalyticsIntegrationFactAttribute : FactAttribute
{
    public ApplicationAnalyticsIntegrationFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("AIGC_ANALYTICS_TEST_POSTGRES")))
            Skip = "Set isolated AIGC_ANALYTICS_TEST_POSTGRES to run PostgreSQL verification.";
    }
}

public sealed class ApplicationAnalyticsIntegrationTests
{
    [ApplicationAnalyticsIntegrationFact]
    public async Task Upgrade_existing_schema_and_persist_concurrent_deduplication_and_period_offsets()
    {
        var connection = Environment.GetEnvironmentVariable("AIGC_ANALYTICS_TEST_POSTGRES")!;
        var target = new NpgsqlConnectionStringBuilder(connection);
        Assert.Equal("aigc_analytics_test", target.Database);
        Assert.Contains(target.Host, new[] { "localhost", "127.0.0.1" });
        var options = new DbContextOptionsBuilder<AigcHubDbContext>().UseNpgsql(connection).Options;
        await using var db = new AigcHubDbContext(options);
        await db.Database.EnsureCreatedAsync();
        try
        {
            // Recreate the prior schema shape, only in the guarded disposable test database.
            await db.Database.ExecuteSqlRawAsync("""
                ALTER TABLE aigc_hub."Categories" DROP COLUMN "ParentId" CASCADE;
                DROP TABLE aigc_hub."ApplicationClicks";
                DROP TABLE aigc_hub."ApplicationClickAdjustments";
                """);
            await DatabaseSchemaInitializer.ApplyAdditiveChangesAsync(db);
            await DatabaseSchemaInitializer.ApplyAdditiveChangesAsync(db);
            var root = new AppCategory {Code = "parent", Name = "Parent"};
            var child = new AppCategory {Code = "child", Name = "Child", ParentId = root.Id};
            db.Categories.AddRange(root, child); await db.SaveChangesAsync();
            var app = new RegisteredApplication {Name = "Analytics", CategoryId = child.Id};
            db.RegisteredApplications.Add(app); await db.SaveChangesAsync();
            var user = Guid.NewGuid(); var visit = Guid.NewGuid();
            await Task.WhenAll(Enumerable.Range(0, 12).Select(async i => {
                await using var writer = new AigcHubDbContext(options);
                await ApplicationClickService.MutateAsync(writer, app.Id, async () => {
                    await ApplicationClickService.RecordAsync(writer, app.Id, user, i < 6 ? visit : Guid.NewGuid(), default);
                    return true;
                }, default);
            }));
            Assert.Equal(1, await db.ApplicationClicks.CountAsync());
            await ApplicationClickService.MutateAsync(db, app.Id, async () => {
                await ApplicationClickService.AdjustAsync(db, app.Id, user, new(10, 20, 30, 40), default); return true;
            }, default);
            await using var reader = new AigcHubDbContext(options);
            var counts = (await ApplicationClickService.CountsAsync(reader, [app.Id], DateTimeOffset.UtcNow, default))[app.Id];
            Assert.Equal(new ApplicationClickCounts(10, 20, 30, 40), counts);
            await ApplicationClickService.MutateAsync(reader, app.Id, async () => {
                await ApplicationClickService.RecordAsync(reader, app.Id, Guid.NewGuid(), Guid.NewGuid(), default); return true;
            }, default);
            counts = (await ApplicationClickService.CountsAsync(reader, [app.Id], DateTimeOffset.UtcNow, default))[app.Id];
            Assert.Equal(new ApplicationClickCounts(11, 21, 31, 41), counts);
            var history = await ApplicationClickService.HistoryAsync(reader, [app.Id], null, null, DateTimeOffset.UtcNow, default);
            Assert.Equal(30, history.Trend.Count);
            Assert.Equal(2, history.Trend.Sum(x => x.Clicks)); // Raw events, excluding manual adjustments.
            var boundaryApp = new RegisteredApplication {Name = "Boundary", CategoryId = child.Id};
            reader.RegisteredApplications.Add(boundaryApp);
            reader.ApplicationClicks.AddRange(new ApplicationClick {ApplicationId = boundaryApp.Id, UserId = user, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.Parse("2027-01-03T15:59:59Z")},
                new ApplicationClick {ApplicationId = boundaryApp.Id, UserId = user, VisitId = Guid.NewGuid(), CreatedAt = DateTimeOffset.Parse("2027-01-03T16:00:00Z")});
            await reader.SaveChangesAsync();
            var boundary = await ApplicationClickService.HistoryAsync(reader, [boundaryApp.Id], "2027-01-03", "2027-01-06", DateTimeOffset.Parse("2027-01-05T16:00:00Z"), default);
            Assert.Equal(new long[] {1, 1, 0}, boundary.Trend.Select(x => x.Clicks).ToArray());

            var category = await reader.RegisteredApplications.AsNoTracking().Where(x => x.Id == app.Id)
                .Select(x => new {Root = x.Category!.Parent!.Name, Child = x.Category.Name}).SingleAsync();
            Assert.Equal("Parent", category.Root); Assert.Equal("Child", category.Child);
            Assert.Equal(1, await reader.OperationAudits.CountAsync(x => x.Action == "application.clicks.adjust"));
        }
        finally { await db.Database.EnsureDeletedAsync(); }
    }
}
