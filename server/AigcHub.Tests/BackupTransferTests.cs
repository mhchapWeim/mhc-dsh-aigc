using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class BackupTransferTests
{
    [Fact]
    public async Task ExpiredUploadsReleaseReservationsAndCannotResume()
    {
        using var factory = new Factory();
        using var owner = await Login(factory, "wh00412");
        var response = await owner.PostAsJsonAsync("/v1/backup-transfers", Input([1, 2, 3]));
        response.EnsureSuccessStatusCode();
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var row = await db.DshBackups.SingleAsync(x => x.Id == id);
        row.CreatedAt = DateTimeOffset.UtcNow.AddDays(-8);
        await db.SaveChangesAsync();
        Assert.Equal(HttpStatusCode.Gone, (await owner.GetAsync($"/v1/backup-transfers/{id}")).StatusCode);
        await BackupTransferCleanup.CleanAsync(db, factory.Store, new BackupStorageOptions { Enabled = true }, default);
        Assert.False(await db.DshBackups.AnyAsync(x => x.Id == id));
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/v1/backup-transfers/{id}")).StatusCode);
        Assert.Equal(0, (await owner.GetFromJsonAsync<JsonElement>("/v1/backup-transfers/limits")).GetProperty("usedBytes").GetInt64());
    }

    [Fact]
    public async Task PartsResumeAndOnlyVerifiedObjectsAppearInHistory()
    {
        using var factory = new Factory();
        using var owner = await Login(factory, "wh00412");
        using var other = await Login(factory, "wh00028");
        var bytes = RandomNumberGenerator.GetBytes(5 * 1024 * 1024 + 321);
        var input = Input(bytes);
        var started = await owner.PostAsJsonAsync("/v1/backup-transfers", input);
        started.EnsureSuccessStatusCode();
        var id = (await started.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        Assert.Equal(0, (await owner.GetFromJsonAsync<JsonElement>("/v1/backups")).GetProperty("total").GetInt32());
        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/v1/backup-transfers/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await owner.PostAsync($"/v1/backup-transfers/{id}/complete", null)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.PutAsync($"/v1/backup-transfers/{id}/parts/1", new ByteArrayContent(bytes[..10]))).StatusCode);
        (await owner.PutAsync($"/v1/backup-transfers/{id}/parts/1", new ByteArrayContent(bytes[..(5 * 1024 * 1024)]))).EnsureSuccessStatusCode();
        var status = await owner.GetFromJsonAsync<JsonElement>($"/v1/backup-transfers/{id}");
        Assert.Equal(1, status.GetProperty("parts").GetArrayLength());
        Assert.Equal(1, status.GetProperty("parts")[0].GetProperty("number").GetInt32());
        (await owner.PutAsync($"/v1/backup-transfers/{id}/parts/2", new ByteArrayContent(bytes[(5 * 1024 * 1024)..]))).EnsureSuccessStatusCode();
        (await owner.PostAsync($"/v1/backup-transfers/{id}/complete", null)).EnsureSuccessStatusCode();
        (await owner.PostAsync($"/v1/backup-transfers/{id}/complete", null)).EnsureSuccessStatusCode();
        Assert.Equal(1, (await owner.GetFromJsonAsync<JsonElement>("/v1/backups")).GetProperty("total").GetInt32());
        using var range = new HttpRequestMessage(HttpMethod.Get, $"/v1/backup-transfers/{id}/download");
        range.Headers.Range = new RangeHeaderValue(17, 33);
        var download = await owner.SendAsync(range);
        Assert.Equal(HttpStatusCode.PartialContent, download.StatusCode);
        Assert.Equal(bytes[17..34], await download.Content.ReadAsByteArrayAsync());
        using var scope = factory.Services.CreateScope();
        var row = await scope.ServiceProvider.GetRequiredService<AigcHubDbContext>().DshBackups.SingleAsync();
        Assert.True(row.Payload.Length < 3000, "The database must contain metadata, not the backup body");
        Assert.Equal("minio-v2", BackupTransferEndpoints.Descriptor(row)!.StorageKind);
        (await owner.DeleteAsync($"/v1/backup-transfers/{id}")).EnsureSuccessStatusCode();
        Assert.Empty(factory.Store.Objects);
    }

    [Fact]
    public async Task BadHashesNeverBecomeRestorableAndQuotaIncludesUnfinishedTransfers()
    {
        using var factory = new Factory();
        using var owner = await Login(factory, "wh00412");
        var bytes = new byte[6 * 1024 * 1024];
        var first = await owner.PostAsJsonAsync("/v1/backup-transfers", Input(bytes));
        first.EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Conflict, (await owner.PostAsJsonAsync("/v1/backup-transfers", Input(bytes))).StatusCode);
        var id = (await first.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await owner.DeleteAsync($"/v1/backup-transfers/{id}")).EnsureSuccessStatusCode();
        var bad = await owner.PostAsJsonAsync("/v1/backup-transfers", Input(new byte[10], new string('a', 64)));
        bad.EnsureSuccessStatusCode();
        id = (await bad.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await owner.PutAsync($"/v1/backup-transfers/{id}/parts/1", new ByteArrayContent(new byte[10]))).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await owner.PostAsync($"/v1/backup-transfers/{id}/complete", null)).StatusCode);
        Assert.Equal(0, (await owner.GetFromJsonAsync<JsonElement>("/v1/backups")).GetProperty("total").GetInt32());
    }

    [Fact]
    public void ManifestRejectsTraversalAndCapacityOverflow()
    {
        var valid = Input(new byte[10]);
        var options = new BackupStorageOptions();
        Assert.Equal(1, BackupTransferEndpoints.Validate(valid, options));
        var bad = valid with { Manifest = JsonSerializer.SerializeToElement(new { version = 2,
            sessions = new[] { new { id = "one", title = "one", file = "../outside.json", bytes = 10, sha256 = new string('a', 64) } }, objects = Array.Empty<object>() }) };
        Assert.Throws<WorkflowException>(() => BackupTransferEndpoints.Validate(bad, options));
        Assert.Throws<WorkflowException>(() => BackupTransferEndpoints.Validate(valid with { Bytes = options.MaximumBytes + 1 }, options));
    }

    private static BackupTransferEndpoints.StartInput Input(byte[] bytes, string? hash = null) => new(bytes.Length,
        hash ?? Convert.ToHexStringLower(SHA256.HashData(bytes)), "all", JsonSerializer.SerializeToElement(new { version = 2,
            sessions = new[] { new { id = "session-one", title = "设备方案", file = "sessions/" + new string('a', 64) + ".json", bytes = 1, sha256 = new string('a', 64) } }, objects = Array.Empty<object>() }));

    private static async Task<HttpClient> Login(Factory factory, string username)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/v1/auth/login", new { username, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("access_token").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string root = Path.Combine(Path.GetTempPath(), "backup-transfers-" + Guid.NewGuid().ToString("N"));
        public MemoryStore Store { get; } = new();
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseSetting("DataProtection:KeysPath", Path.Combine(root, "keys"));
            builder.UseSetting("FileLogging:Directory", Path.Combine(root, "logs"));
            builder.ConfigureServices(services => {
                services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
                services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
                services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(root));
                services.RemoveAll<IBackupObjectStore>(); services.AddSingleton<IBackupObjectStore>(Store);
                services.Configure<BackupStorageOptions>(options => { options.Enabled = true; options.PartBytes = 5 * 1024 * 1024;
                    options.MaximumBytes = 8 * 1024 * 1024; options.AccountQuotaBytes = 10 * 1024 * 1024; });
            });
        }
        protected override void Dispose(bool disposing) { base.Dispose(disposing); if (Directory.Exists(root)) Directory.Delete(root, true); }
    }

    internal sealed class MemoryStore : IBackupObjectStore
    {
        public Dictionary<string, byte[]> Objects { get; } = [];
        private readonly Dictionary<string, SortedDictionary<int, byte[]>> uploads = [];
        public Task<string> StartAsync(string key, CancellationToken ct) { var id = Guid.NewGuid().ToString(); uploads[id] = []; return Task.FromResult(id); }
        public Task<IReadOnlyList<BackupPart>> PartsAsync(string key, string uploadId, CancellationToken ct) => Task.FromResult<IReadOnlyList<BackupPart>>(uploads[uploadId].Select(pair => new BackupPart(pair.Key, pair.Value.Length, "etag-" + pair.Key)).ToList());
        public async Task PutAsync(string key, string uploadId, int number, Stream input, long bytes, CancellationToken ct) { using var stream = new MemoryStream(); await input.CopyToAsync(stream, ct); uploads[uploadId][number] = stream.ToArray(); }
        public Task CompleteAsync(string key, string uploadId, IReadOnlyList<BackupPart> parts, CancellationToken ct) { Objects[key] = uploads[uploadId].Values.SelectMany(x => x).ToArray(); return Task.CompletedTask; }
        public async Task ReadAsync(string key, long? start, long? end, Func<Stream, Task> consume, CancellationToken ct) { var data = Objects[key]; using var stream = new MemoryStream(start.HasValue ? data[(int)start.Value..((int)end!.Value + 1)] : data); await consume(stream); }
        public Task DeleteAsync(string key, string? uploadId, CancellationToken ct) { Objects.Remove(key); if (uploadId is not null) uploads.Remove(uploadId); return Task.CompletedTask; }
    }
}
