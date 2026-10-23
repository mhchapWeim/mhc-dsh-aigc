using System.Security.Cryptography;
using AigcHub.Api.Services;
using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public sealed class MinioBackupIntegrationTests
{
    [MinioFact]
    public async Task MultipartNonSeekableStreamResumeRangeAndAbort()
    {
        var endpoint = Environment.GetEnvironmentVariable("BACKUP_TEST_MINIO");
        if (endpoint is null) return; // Opt-in local integration fixture, never production.
        var options = new BackupStorageOptions { Enabled = true, Endpoint = endpoint,
            AccessKey = Environment.GetEnvironmentVariable("BACKUP_TEST_APP_KEY") ?? "backup-test-user",
            SecretKey = Environment.GetEnvironmentVariable("BACKUP_TEST_APP_SECRET") ?? "backup-test-password",
            Bucket = Environment.GetEnvironmentVariable("BACKUP_TEST_BUCKET") ?? "backup-test-" + Guid.NewGuid().ToString("N") };
        using var client = new AmazonS3Client(new BasicAWSCredentials("backup-test-user", "backup-test-password"),
            new AmazonS3Config { ServiceURL = endpoint, ForcePathStyle = true, AuthenticationRegion = "us-east-1" });
        try { await client.PutBucketAsync(new PutBucketRequest { BucketName = options.Bucket }); }
        catch (AmazonS3Exception ex) when (ex.ErrorCode == "BucketAlreadyOwnedByYou") { }
        using var store = new BackupObjectStore(Options.Create(options));
        var data = RandomNumberGenerator.GetBytes(5 * 1024 * 1024 + 379);
        const string key = "accounts/test/snapshot.tar.gz";
        try {
            var upload = await store.StartAsync(key, default);
            using (var input = new NonSeekable(data[..(5 * 1024 * 1024)]))
                await store.PutAsync(key, upload, 1, input, 5 * 1024 * 1024, default);
            Assert.Single(await store.PartsAsync(key, upload, default));
            using (var input = new NonSeekable(data[(5 * 1024 * 1024)..]))
                await store.PutAsync(key, upload, 2, input, 379, default);
            await store.CompleteAsync(key, upload, await store.PartsAsync(key, upload, default), default);
            await store.ReadAsync(key, null, null, async input => {
                Assert.Equal(SHA256.HashData(data), await SHA256.HashDataAsync(input));
            }, default);
            await store.ReadAsync(key, 13, 39, async input => {
                using var output = new MemoryStream(); await input.CopyToAsync(output);
                Assert.Equal(data[13..40], output.ToArray());
            }, default);
            var abandoned = await store.StartAsync("accounts/test/abandoned", default);
            await store.DeleteAsync("accounts/test/abandoned", abandoned, default);
            await store.DeleteAsync(key, null, default);
        } finally { await client.DeleteBucketAsync(options.Bucket); }
    }

    private sealed class NonSeekable(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
        public override long Seek(long offset, SeekOrigin loc) => throw new NotSupportedException();
    }
}

internal sealed class MinioFactAttribute : FactAttribute
{
    public MinioFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("BACKUP_TEST_MINIO") is null) Skip = "Set BACKUP_TEST_MINIO to run against an isolated local MinIO fixture.";
    }
}
