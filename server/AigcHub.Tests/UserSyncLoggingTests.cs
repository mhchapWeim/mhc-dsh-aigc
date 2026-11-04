using System.Collections.Concurrent;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public sealed class UserSyncLoggingTests
{
    [Fact]
    public async Task LogsRetryScheduleExhaustionAndConfirmedDeliveryWithoutPayloadOrExceptionSecrets()
    {
        await using var db = Database();
        db.Users.Add(new AppUser { EmployeeNo="private-employee",Name="private-name",Email="private@example.test",PasswordHash="private-hash" });
        await db.SaveChangesAsync();
        var message = await db.UserSyncMessages.SingleAsync();
        message.BatchId = Guid.NewGuid(); await db.SaveChangesAsync();
        var log = new Logs<UserSyncDispatcher>();
        var publisher = new Publisher();
        var dispatcher = new UserSyncDispatcher(db,publisher,Options.Create(new UserSyncOptions {Enabled=true,MaximumAttempts=2}),log);
        await dispatcher.SendNextAsync(default);
        var scheduled = Assert.Single(log.Items);
        Assert.Equal(UserSyncLog.RetryScheduled,scheduled.Id); Assert.Equal(LogLevel.Warning,scheduled.Level);
        Assert.Equal(message.Id,scheduled.State["EventId"]); Assert.Equal(message.BatchId,scheduled.State["BatchId"]);
        Assert.Equal(true,scheduled.State["AutoRetry"]); Assert.NotNull(scheduled.State["NextAttemptAt"]);
        message.NextAttemptAt=DateTimeOffset.MinValue; await db.SaveChangesAsync();
        await dispatcher.SendNextAsync(default);
        var exhausted=log.Items.Last();
        Assert.Equal(UserSyncLog.RetryExhausted,exhausted.Id);
        Assert.Equal(false,exhausted.State["AutoRetry"]); Assert.Null(exhausted.State["NextAttemptAt"]);
        Assert.False(await dispatcher.SendNextAsync(default)); Assert.Equal(2,log.Items.Count);
        message.Status="Pending"; message.ConsecutiveFailures=0; await db.SaveChangesAsync(); publisher.Fail=false;
        await dispatcher.SendNextAsync(default);
        var sent=log.Items.Last(); Assert.Equal(UserSyncLog.Sent,sent.Id); Assert.Equal(LogLevel.Information,sent.Level);
        Assert.Equal(message.Id,sent.State["EventId"]); Assert.Equal(3,sent.State["Attempt"]); Assert.NotNull(sent.State["SentAt"]);
        Assert.All(log.Items,item=> {
            Assert.Null(item.Exception);
            Assert.DoesNotContain("secret-password",item.Text); Assert.DoesNotContain("private-",item.Text);
            Assert.DoesNotContain("private@example.test",item.Text); Assert.DoesNotContain(message.Payload,item.Text);
            Assert.DoesNotContain("Payload",item.State.Keys);
        });
    }

    [Fact]
    public async Task DoesNotLogSentWhenSavingTheConfirmedOutboxStateFails()
    {
        await using var db = Database(new RejectSentSave());
        db.Users.Add(new AppUser {EmployeeNo="test",Name="test",Email="test@example.test",PasswordHash="test"});
        await db.SaveChangesAsync();
        var log=new Logs<UserSyncDispatcher>();
        var dispatcher=new UserSyncDispatcher(db,new Publisher {Fail=false},Options.Create(new UserSyncOptions {Enabled=true}),log);
        await Assert.ThrowsAsync<InvalidOperationException>(()=>dispatcher.SendNextAsync(default));
        Assert.Empty(log.Items);
    }

    [Fact]
    public async Task DisabledWorkerLogsStartupAndShutdownWithoutConnectingOrPollingNoise()
    {
        using var provider=new ServiceCollection().BuildServiceProvider();
        var log=new Logs<UserSyncWorker>();
        using var worker=new UserSyncWorker(provider.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new UserSyncOptions {PollSeconds=300,Password="worker-secret"}),log);
        await worker.StartAsync(default);
        await worker.StopAsync(default);
        Assert.Equal(new[] {UserSyncLog.WorkerStarted,UserSyncLog.Disabled,UserSyncLog.WorkerStopped},log.Items.Select(x=>x.Id));
        Assert.All(log.Items,item=>Assert.DoesNotContain("worker-secret",item.Text));
        Assert.Equal("nj304",log.Items.First().State["Host"]);
    }

    private static AigcHubDbContext Database(params IInterceptor[] interceptors) => new(new DbContextOptionsBuilder<AigcHubDbContext>()
        .UseInMemoryDatabase(Guid.NewGuid().ToString()).AddInterceptors(interceptors).Options);
    private sealed class RejectSentSave : SaveChangesInterceptor
    {
        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,InterceptionResult<int> result,CancellationToken cancellationToken=default)
        {
            if(eventData.Context!.ChangeTracker.Entries<UserSyncMessage>().Any(x=>x.Entity.Status=="Sent"))
                throw new InvalidOperationException("simulated persistence failure");
            return ValueTask.FromResult(result);
        }
    }
    private sealed class Publisher : IUserSyncPublisher
    {
        public bool Fail {get;set;}=true;
        public Task PublishAsync(UserSyncMessage message,CancellationToken ct) => Fail
            ? Task.FromException(new InvalidOperationException("amqp://producer:secret-password@host "+message.Payload))
            : Task.CompletedTask;
    }
    private sealed record LogItem(EventId Id,LogLevel Level,string Text,Dictionary<string,object?> State,Exception? Exception);
    private sealed class Logs<T> : ILogger<T>
    {
        public ConcurrentQueue<LogItem> Items {get;}=new();
        public IDisposable? BeginScope<TState>(TState state) where TState:notnull => null;
        public bool IsEnabled(LogLevel logLevel)=>true;
        public void Log<TState>(LogLevel logLevel,EventId eventId,TState state,Exception? exception,Func<TState,Exception?,string> formatter) =>
            Items.Enqueue(new LogItem(eventId,logLevel,formatter(state,exception),
                ((IEnumerable<KeyValuePair<string,object?>>)state!).ToDictionary(x=>x.Key,x=>x.Value),exception));
    }
}
