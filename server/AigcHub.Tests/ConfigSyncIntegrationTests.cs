using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Npgsql;
using RabbitMQ.Client;

namespace AigcHub.Tests;

public sealed class ConfigSyncIntegrationFactAttribute : FactAttribute
{
    public ConfigSyncIntegrationFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AIGC_CONFIG_SYNC_TEST_POSTGRES")) ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AIGC_CONFIG_SYNC_TEST_MQ_PORT")))
            Skip = "Set isolated AIGC_CONFIG_SYNC_TEST_POSTGRES and AIGC_CONFIG_SYNC_TEST_MQ_PORT.";
    }
}

public sealed class ConfigSyncIntegrationTests
{
    [ConfigSyncIntegrationFact]
    public async Task Postgres_rollback_concurrent_versions_and_two_real_mq_gateways_converge()
    {
        var connectionString = Environment.GetEnvironmentVariable("AIGC_CONFIG_SYNC_TEST_POSTGRES")!;
        var target = new NpgsqlConnectionStringBuilder(connectionString);
        Assert.Equal("aigc_configsync_test", target.Database);
        Assert.Contains(target.Host, new[] { "127.0.0.1", "localhost" });
        var options = new DbContextOptionsBuilder<AigcHubDbContext>().UseNpgsql(connectionString).Options;
        await using var db = new AigcHubDbContext(options);
        await db.Database.EnsureCreatedAsync(); await DatabaseSchemaInitializer.ApplyAdditiveChangesAsync(db);
        try
        {
            await using (var transaction = await db.Database.BeginTransactionAsync())
            {
                db.TokenBillingPlans.Add(new TokenBillingPlan { Name = "rolled-back", WeeklyTokens = 100 });
                await db.SaveChangesAsync(); await transaction.RollbackAsync();
            }
            db.ChangeTracker.Clear();
            Assert.Empty(await db.TokenBillingPlans.ToArrayAsync()); Assert.Empty(await db.ConfigSyncEvents.ToArrayAsync());
            var tasks = Enumerable.Range(0, 4).Select(async index =>
            {
                await using var writer = new AigcHubDbContext(options);
                writer.TokenBillingPlans.Add(new TokenBillingPlan { Name = $"plan-{index}", WeeklyTokens = 100 });
                await writer.SaveChangesAsync();
            });
            await Task.WhenAll(tasks);
            Assert.Equal(4, await db.ConfigSyncEvents.CountAsync());
            Assert.Equal(new long[] { 1, 2, 3, 4 }, await db.ConfigSyncEvents.OrderBy(x => x.Revision).Select(x => x.Revision).ToArrayAsync());

            var port = int.Parse(Environment.GetEnvironmentVariable("AIGC_CONFIG_SYNC_TEST_MQ_PORT")!);
            var adminFactory = new ConnectionFactory { HostName = "127.0.0.1", Port = port, VirtualHost = "/aigc", UserName = "config-test-admin", Password = "test-admin-only-20261103" };
            await using var adminConnection = await adminFactory.CreateConnectionAsync();
            await using var adminChannel = await adminConnection.CreateChannelAsync();
            await adminChannel.ExchangeDeclareAsync("aigc.config.events", "topic", true);
            var settings = Options.Create(new ConfigSyncOptions { Enabled = true, HostName = "127.0.0.1", Port = port,
                UserName = "aigc_config_runtime", Password = "test-config-only-20261103" });
            var services = new ServiceCollection(); services.AddDbContext<AigcHubDbContext>(builder => builder.UseNpgsql(connectionString));
            await using var provider = services.BuildServiceProvider();
            var signalsA = new ConfigSyncSignals(); var signalsB = new ConfigSyncSignals();
            using var workerA = new ConfigSyncWorker(provider.GetRequiredService<IServiceScopeFactory>(), settings, signalsA, NullLogger<ConfigSyncWorker>.Instance);
            using var workerB = new ConfigSyncWorker(provider.GetRequiredService<IServiceScopeFactory>(), settings, signalsB, NullLogger<ConfigSyncWorker>.Instance);
            await workerA.StartAsync(default); await workerB.StartAsync(default);
            try
            {
                await Until(async () => signalsA.MqConnected && signalsB.MqConnected && await db.ConfigSyncEvents.AllAsync(x => x.Status == "Sent"));
                var a = signalsA.Subscribe(); var b = signalsB.Subscribe();
                db.TokenBillingPlans.Add(new TokenBillingPlan { Name = "fanout", WeeklyTokens = 200 }); await db.SaveChangesAsync();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                Assert.True(await a.Reader.ReadAsync(timeout.Token)); Assert.True(await b.Reader.ReadAsync(timeout.Token));
                await Until(async () => await db.ConfigSyncEvents.AsNoTracking().AllAsync(x => x.Status == "Sent"));
                signalsA.Remove(a.Id); signalsB.Remove(b.Id);
            }
            finally { await workerA.StopAsync(default); await workerB.StopAsync(default); }
            Assert.False(signalsA.MqConnected); Assert.False(signalsB.MqConnected);
        }
        finally { await db.Database.EnsureDeletedAsync(); }
    }

    private static async Task Until(Func<Task<bool>> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        while (!await predicate()) await Task.Delay(100, timeout.Token);
    }
}
