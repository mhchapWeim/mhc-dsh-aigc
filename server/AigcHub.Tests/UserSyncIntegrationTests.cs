using Microsoft.Extensions.Logging.Abstractions;
using System.Text;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using RabbitMQ.Client;
using RabbitMQ.Client.Exceptions;

namespace AigcHub.Tests;

public sealed class UserSyncIntegrationFactAttribute : FactAttribute
{
    public UserSyncIntegrationFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AIGC_TEST_POSTGRES")) ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AIGC_TEST_RABBITMQ_PORT")))
            Skip = "Set AIGC_TEST_POSTGRES and AIGC_TEST_RABBITMQ_PORT for isolated PostgreSQL/RabbitMQ validation.";
    }
}

public sealed class UserSyncIntegrationTests
{
    [UserSyncIntegrationFact]
    public async Task PostgresOutboxRollsBackAndRejectsStaleVersionsAndRabbitConfirmsOrReturnsRealMessages()
    {
        var connectionString = Environment.GetEnvironmentVariable("AIGC_TEST_POSTGRES")!;
        var target = new NpgsqlConnectionStringBuilder(connectionString);
        Assert.Equal("aigc_usersync_test", target.Database);
        Assert.Contains(target.Host, new[] { "127.0.0.1", "localhost" });
        var databaseOptions = new DbContextOptionsBuilder<AigcHubDbContext>().UseNpgsql(connectionString).Options;
        await using var db = new AigcHubDbContext(databaseOptions);
        await db.Database.EnsureCreatedAsync();
        await UserSyncSchema.ApplyAsync(db, default);
        await UserSyncSchema.ApplyAsync(db, default);
        try
        {
            // The caller's transaction contains both the user and outbox row.
            await using (var transaction = await db.Database.BeginTransactionAsync())
            {
                db.Users.Add(NewUser("rollback")); await db.SaveChangesAsync();
                Assert.Equal(1, await db.UserSyncMessages.CountAsync());
                await transaction.RollbackAsync();
            }
            db.ChangeTracker.Clear();
            Assert.Empty(await db.Users.ToArrayAsync()); Assert.Empty(await db.UserSyncMessages.ToArrayAsync());
            var user = NewUser("persisted"); db.Users.Add(user); await db.SaveChangesAsync();
            await using (var concurrent = new AigcHubDbContext(databaseOptions))
            {
                var stale = await concurrent.Users.SingleAsync();
                user.Name = "新资料"; await db.SaveChangesAsync();
                stale.Name = "不应覆盖";
                await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => concurrent.SaveChangesAsync());
            }
            Assert.Equal(2, await db.UserSyncMessages.CountAsync());
            var settings = new UserSyncOptions { Enabled = true, HostName = "127.0.0.1",
                Port = int.Parse(Environment.GetEnvironmentVariable("AIGC_TEST_RABBITMQ_PORT")!),
                UserName = "aigc_user_producer", Password = "test-producer-only-20261102" };
            var options = Options.Create(settings);
            await using var publisher = new RabbitUserSyncPublisher(options, NullLogger<RabbitUserSyncPublisher>.Instance);
            var dispatcher = new UserSyncDispatcher(db, publisher, options, NullLogger<UserSyncDispatcher>.Instance);
            Assert.True(await dispatcher.SendNextAsync(default));
            var sent = await db.UserSyncMessages.SingleAsync(x => x.Status == "Sent");
            Assert.NotNull(sent.SentAt);
            var factory = new ConnectionFactory { HostName = "127.0.0.1", Port = settings.Port, VirtualHost = "/aigc",
                UserName = "aigc_user_service_1", Password = "test-consumer-only-20261102" };
            await using var consumer = await factory.CreateConnectionAsync();
            await using var channel = await consumer.CreateChannelAsync();
            var received = await channel.BasicGetAsync("aigc.users.service-1", false);
            while (received is not null && received.BasicProperties.MessageId != sent.Id.ToString())
            {
                await channel.BasicAckAsync(received.DeliveryTag, false);
                received = await channel.BasicGetAsync("aigc.users.service-1", false);
            }
            Assert.NotNull(received); Assert.Equal(sent.Id.ToString(), received.BasicProperties.MessageId);
            Assert.True(received.BasicProperties.Persistent);
            Assert.Equal("application/json", received.BasicProperties.ContentType);
            var payload = JsonDocument.Parse(received.Body).RootElement;
            Assert.Equal(sent.Id, payload.GetProperty("eventId").GetGuid());
            Assert.DoesNotContain("password", Encoding.UTF8.GetString(received.Body.Span), StringComparison.OrdinalIgnoreCase);
            await channel.BasicAckAsync(received.DeliveryTag, false);

            // An existing Exchange with no matching binding must not be marked sent.
            using var http = new HttpClient();
            http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Basic",
                Convert.ToBase64String(Encoding.UTF8.GetBytes("aigc_mq_admin:test-admin-only-20261102")));
            var managementPort = Environment.GetEnvironmentVariable("AIGC_TEST_RABBITMQ_MANAGEMENT_PORT")!;
            (await http.PutAsync($"http://127.0.0.1:{managementPort}/api/exchanges/%2Faigc/aigc.unrouted-test",
                new StringContent("{\"type\":\"topic\",\"durable\":true}", Encoding.UTF8, "application/json"))).EnsureSuccessStatusCode();
            // Admin is used only in this negative integration assertion; the real dispatcher above used write-only credentials.
            var unroutedOptions = Options.Create(new UserSyncOptions { Enabled=true,HostName="127.0.0.1",Port=settings.Port,
                UserName="aigc_mq_admin",Password="test-admin-only-20261102",Exchange="aigc.unrouted-test" });
            await using var unrouted = new RabbitUserSyncPublisher(unroutedOptions, NullLogger<RabbitUserSyncPublisher>.Instance);
            var second = await db.UserSyncMessages.SingleAsync(x => x.Status == "Pending");
            await Assert.ThrowsAsync<PublishReturnException>(() => unrouted.PublishAsync(second, default));
            Assert.Equal("Pending", second.Status);
            Assert.True(await new UserSyncDispatcher(db, unrouted, unroutedOptions, NullLogger<UserSyncDispatcher>.Instance).SendNextAsync(default));
            Assert.Equal("Failed", second.Status); Assert.Null(second.SentAt);
            Assert.Equal(1, second.Attempts);
            // Connection/channel failure above does not prevent a subsequent valid retry with the same event id.
            second.Status="Pending"; second.ConsecutiveFailures=0; await db.SaveChangesAsync();
            Assert.True(await dispatcher.SendNextAsync(default));
            var retried = await channel.BasicGetAsync("aigc.users.service-1",false);
            Assert.NotNull(retried); Assert.Equal(second.Id.ToString(),retried.BasicProperties.MessageId);
            await channel.BasicAckAsync(retried.DeliveryTag,false);
        }
        finally { await db.Database.EnsureDeletedAsync(); }
    }
    private static AppUser NewUser(string suffix) => new() { EmployeeNo="test-"+suffix,Name="用户",Email=suffix+"@example.test",PasswordHash="never-export" };
}
