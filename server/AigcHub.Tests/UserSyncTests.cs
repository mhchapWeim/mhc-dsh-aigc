using Microsoft.Extensions.Logging.Abstractions;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public sealed class UserSyncTests
{
    private static AigcHubDbContext Database(string? name = null) => new(new DbContextOptionsBuilder<AigcHubDbContext>()
        .UseInMemoryDatabase(name ?? Guid.NewGuid().ToString()).Options);
    private static AppUser User(Guid? department = null) => new() { EmployeeNo = Guid.NewGuid().ToString("N"),
        Name = "测试用户", Email = Guid.NewGuid() + "@example.test", PasswordHash = "never-sync-this-password-hash", DepartmentId = department };

    [Fact]
    public async Task UserChangesAreCapturedAtSaveIncludingDepartmentChangesButNotLoginOrPassword()
    {
        await using var db = Database();
        var department = new Department { Code = "rd", Name = "研发" };
        db.Departments.Add(department);
        var user = User(department.Id); db.Users.Add(user);
        await db.SaveChangesAsync();
        var first = Assert.Single(await db.UserSyncMessages.ToArrayAsync());
        Assert.Equal(1, user.SyncVersion);
        var body = JsonDocument.Parse(first.Payload).RootElement;
        Assert.Equal("研发", body.GetProperty("user").GetProperty("department").GetProperty("name").GetString());
        Assert.DoesNotContain(user.PasswordHash, first.Payload);
        Assert.DoesNotContain("password", first.Payload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("token", first.Payload, StringComparison.OrdinalIgnoreCase);
        user.LastLoginAt = DateTimeOffset.UtcNow; user.PasswordHash = "changed-secret";
        await db.SaveChangesAsync();
        Assert.Single(await db.UserSyncMessages.ToArrayAsync());
        user.Name = "新姓名"; user.IsEnabled = false;
        await db.SaveChangesAsync();
        Assert.Equal(2, user.SyncVersion);
        department.Name = "新部门";
        await db.SaveChangesAsync();
        Assert.Equal(3, user.SyncVersion);
        var latest = await db.UserSyncMessages.SingleAsync(x => x.UserVersion == 3);
        Assert.Contains("新部门", System.Text.RegularExpressions.Regex.Unescape(latest.Payload));
        db.Users.Remove(user); await db.SaveChangesAsync();
        var tombstone = await db.UserSyncMessages.SingleAsync(x => x.EventType == "user.deleted");
        Assert.Equal(4, tombstone.UserVersion);
        Assert.True(JsonDocument.Parse(tombstone.Payload).RootElement.GetProperty("user").GetProperty("isDeleted").GetBoolean());
    }

    [Fact]
    public async Task DepartmentRenameCapturesMembersThatWereNotLoadedInTheEditingContext()
    {
        var name = Guid.NewGuid().ToString();
        Guid departmentId;
        await using (var seed = Database(name))
        {
            var department = new Department { Code = "dept", Name = "旧部门" }; departmentId = department.Id;
            seed.Departments.Add(department); seed.Users.Add(User(departmentId)); await seed.SaveChangesAsync();
        }
        await using var db = Database(name);
        (await db.Departments.SingleAsync()).IsEnabled = false;
        await db.SaveChangesAsync();
        var message = await db.UserSyncMessages.SingleAsync(x => x.UserVersion == 2);
        Assert.False(JsonDocument.Parse(message.Payload).RootElement.GetProperty("user").GetProperty("department").GetProperty("isEnabled").GetBoolean());
    }

    [Fact]
    public async Task DispatcherOnlyMarksConfirmedMessagesAndRetriesTheSameEventWithoutLeakingErrors()
    {
        await using var db = Database(); db.Users.Add(User()); await db.SaveChangesAsync();
        var publisher = new FakePublisher { Fail = true };
        var options = Options.Create(new UserSyncOptions { Enabled = true, MaximumAttempts = 1 });
        var dispatcher = new UserSyncDispatcher(db, publisher, options, NullLogger<UserSyncDispatcher>.Instance);
        Assert.True(await dispatcher.SendNextAsync(default));
        var message = await db.UserSyncMessages.SingleAsync(); var id = message.Id; var payload = message.Payload;
        Assert.Equal("Failed", message.Status); Assert.Null(message.SentAt); Assert.Equal(1, message.Attempts);
        Assert.DoesNotContain("secret-password", message.LastError);
        Assert.False(await dispatcher.SendNextAsync(default));
        message.Status = "Pending"; message.ConsecutiveFailures = 0; await db.SaveChangesAsync(); publisher.Fail = false;
        Assert.True(await dispatcher.SendNextAsync(default));
        Assert.Equal("Sent", message.Status); Assert.NotNull(message.SentAt); Assert.Equal(2, message.Attempts);
        Assert.Equal(id, message.Id); Assert.Equal(payload, message.Payload);
        Assert.Equal(new[] { id, id }, publisher.Ids);
        Assert.False(await dispatcher.SendNextAsync(default));
    }

    [Fact]
    public async Task DisabledDispatcherRetainsEventsWithoutConnecting()
    {
        await using var db = Database(); db.Users.Add(User()); await db.SaveChangesAsync();
        var publisher = new FakePublisher();
        Assert.False(await new UserSyncDispatcher(db, publisher, Options.Create(new UserSyncOptions()), NullLogger<UserSyncDispatcher>.Instance).SendNextAsync(default));
        Assert.Empty(publisher.Ids); Assert.Equal("Pending", (await db.UserSyncMessages.SingleAsync()).Status);
    }

    [Fact]
    public async Task AdminCanCreateIdempotentSnapshotsIncludingDisabledUsersAndReadSafeConnectionInfo()
    {
        using var factory = new Factory(); using var admin = await Login(factory, "wh00028");
        using var ordinary = await Login(factory, "wh00412"); using var anonymous = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/users/sync/summary")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ordinary.GetAsync("/api/users/sync/connection")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await ordinary.PostAsJsonAsync("/api/users/sync/snapshot", new { requestId = Guid.NewGuid() })).StatusCode);
        var info = await admin.GetStringAsync("/api/users/sync/connection");
        Assert.Single(JsonDocument.Parse(info).RootElement.GetProperty("consumers").EnumerateArray());
        Assert.Contains("nj304", info); Assert.DoesNotContain("producer-secret", info); Assert.DoesNotContain("password", info, StringComparison.OrdinalIgnoreCase);
        Guid disabledId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            var user = User(); user.IsEnabled = false; disabledId = user.Id;
            db.Users.Add(user); await db.SaveChangesAsync();
        }
        var batchId = Guid.NewGuid();
        var response = await admin.PostAsJsonAsync("/api/users/sync/snapshot", new { requestId = batchId });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        (await admin.PostAsJsonAsync("/api/users/sync/snapshot", new { requestId = batchId })).EnsureSuccessStatusCode();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
            Assert.Single(await db.UserSyncBatches.ToArrayAsync());
            Assert.Equal(await db.Users.CountAsync(), await db.UserSyncMessages.CountAsync(x => x.BatchId == batchId));
            Assert.Contains(await db.UserSyncMessages.Where(x => x.BatchId == batchId).ToArrayAsync(), x => x.UserId == disabledId);
            var message = await db.UserSyncMessages.FirstAsync(x => x.BatchId == batchId);
            message.Status = "Failed"; message.ConsecutiveFailures = 10; message.Attempts = 10; await db.SaveChangesAsync();
            (await admin.PostAsync($"/api/users/sync/messages/{message.Id}/retry", null)).EnsureSuccessStatusCode();
        }
        var rows = await admin.GetFromJsonAsync<JsonElement>($"/api/users/sync/messages?page=1&pageSize=1&batchId={batchId}");
        Assert.Single(rows.GetProperty("items").EnumerateArray()); Assert.True(rows.GetProperty("total").GetInt32() > 1);
        Assert.DoesNotContain("payload", rows.ToString(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.BadRequest,(await admin.GetAsync("/api/users/sync/messages?status=Invalid")).StatusCode);
        (await admin.GetAsync("/api/users/sync/batches")).EnsureSuccessStatusCode();
        var users = await admin.GetFromJsonAsync<JsonElement>("/api/users?page=1&pageSize=100");
        Assert.All(users.GetProperty("items").EnumerateArray(), user => Assert.Equal("Pending", user.GetProperty("sync").GetProperty("status").GetString()));
    }

    private sealed class FakePublisher : IUserSyncPublisher
    {
        public bool Fail { get; set; }
        public List<Guid> Ids { get; } = [];
        public Task PublishAsync(UserSyncMessage message, CancellationToken ct)
        {
            Ids.Add(message.Id);
            if (Fail) throw new InvalidOperationException("amqp://producer:secret-password@server");
            return Task.CompletedTask;
        }
    }
    private static async Task<HttpClient> Login(Factory factory, string employeeNo)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString());
        return client;
    }
    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string name = "user-sync-" + Guid.NewGuid();
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("UserSync:Enabled", "false"); builder.UseSetting("UserSync:Password", "producer-secret");
            builder.ConfigureServices(services =>
            {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>(); services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(name));
            });
        }
    }
}
