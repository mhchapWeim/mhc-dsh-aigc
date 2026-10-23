using Amazon.Runtime;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;

namespace AigcHub.Api.Services;

public sealed class BackupStorageOptions
{
    public bool Enabled { get; set; }
    public string Endpoint { get; set; } = "http://minio:9000";
    public string AccessKey { get; set; } = "";
    public string SecretKey { get; set; } = "";
    public string Bucket { get; set; } = "dsh-backups";
    public long MaximumBytes { get; set; } = 1024L * 1024 * 1024;
    public long AccountQuotaBytes { get; set; } = 10L * 1024 * 1024 * 1024;
    public int PartBytes { get; set; } = 8 * 1024 * 1024;
    public int UploadLifetimeHours { get; set; } = 168;
}

public sealed record BackupPart(int Number, long Bytes, string ETag);

public interface IBackupObjectStore
{
    Task<string> StartAsync(string key, CancellationToken ct);
    Task<IReadOnlyList<BackupPart>> PartsAsync(string key, string uploadId, CancellationToken ct);
    Task PutAsync(string key, string uploadId, int number, Stream input, long bytes, CancellationToken ct);
    Task CompleteAsync(string key, string uploadId, IReadOnlyList<BackupPart> parts, CancellationToken ct);
    Task ReadAsync(string key, long? start, long? end, Func<Stream, Task> consume, CancellationToken ct);
    Task DeleteAsync(string key, string? uploadId, CancellationToken ct);
}

/// <summary>S3-compatible storage; streams part bodies without collecting a complete backup.</summary>
public sealed class BackupObjectStore(IOptions<BackupStorageOptions> configured) : IBackupObjectStore, IDisposable
{
    private readonly Lazy<IAmazonS3> client = new(() => {
        var options = configured.Value;
        if (!options.Enabled || string.IsNullOrWhiteSpace(options.AccessKey) || string.IsNullOrWhiteSpace(options.SecretKey))
            throw new WorkflowException("MinIO 备份存储尚未配置", 503);
        return new AmazonS3Client(new BasicAWSCredentials(options.AccessKey, options.SecretKey), new AmazonS3Config {
            ServiceURL = options.Endpoint, ForcePathStyle = true, AuthenticationRegion = "us-east-1",
            Timeout = TimeSpan.FromMinutes(20), MaxErrorRetry = 0,
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        });
    });
    private string Bucket => configured.Value.Bucket;

    public async Task<string> StartAsync(string key, CancellationToken ct) =>
        (await client.Value.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest {
            BucketName = Bucket, Key = key, ContentType = "application/gzip",
        }, ct)).UploadId;

    public async Task<IReadOnlyList<BackupPart>> PartsAsync(string key, string uploadId, CancellationToken ct)
    {
        var result = new List<BackupPart>();
        int? marker = null;
        ListPartsResponse page;
        do {
            page = await client.Value.ListPartsAsync(new ListPartsRequest { BucketName = Bucket, Key = key,
                UploadId = uploadId, PartNumberMarker = marker?.ToString(System.Globalization.CultureInfo.InvariantCulture) }, ct);
            result.AddRange((page.Parts ?? []).Select(p => new BackupPart(p.PartNumber ?? 0, p.Size ?? 0, p.ETag)));
            marker = page.NextPartNumberMarker;
        } while (page.IsTruncated == true);
        return result;
    }

    public async Task PutAsync(string key, string uploadId, int number, Stream input, long bytes, CancellationToken ct)
    {
        // SigV4 over the internal HTTP service requires a seekable body to hash.
        // Buffer one bounded part, never the complete archive.
        if (bytes < 1 || bytes > 24 * 1024 * 1024) throw new WorkflowException("备份分片过大", 413);
        using var part = new MemoryStream((int)bytes);
        var buffer = new byte[64 * 1024];
        long remaining = bytes;
        while (remaining > 0) {
            var read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), ct);
            if (read == 0) throw new WorkflowException("备份分片不完整", 400);
            await part.WriteAsync(buffer.AsMemory(0, read), ct);
            remaining -= read;
        }
        part.Position = 0;
        await client.Value.UploadPartAsync(new UploadPartRequest { BucketName = Bucket, Key = key,
            UploadId = uploadId, PartNumber = number, InputStream = part, PartSize = bytes,
            UseChunkEncoding = false, DisableDefaultChecksumValidation = true }, ct);
    }

    public async Task CompleteAsync(string key, string uploadId, IReadOnlyList<BackupPart> parts, CancellationToken ct) =>
        await client.Value.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest { BucketName = Bucket,
            Key = key, UploadId = uploadId, PartETags = parts.OrderBy(p => p.Number).Select(p => new PartETag(p.Number, p.ETag)).ToList() }, ct);

    public async Task ReadAsync(string key, long? start, long? end, Func<Stream, Task> consume, CancellationToken ct)
    {
        var request = new GetObjectRequest { BucketName = Bucket, Key = key };
        if (start.HasValue && end.HasValue) request.ByteRange = new ByteRange(start.Value, end.Value);
        using var response = await client.Value.GetObjectAsync(request, ct);
        await consume(response.ResponseStream);
    }

    public async Task DeleteAsync(string key, string? uploadId, CancellationToken ct)
    {
        if (uploadId is not null) {
            try { await client.Value.AbortMultipartUploadAsync(new AbortMultipartUploadRequest { BucketName = Bucket, Key = key, UploadId = uploadId }, ct); }
            catch (AmazonS3Exception ex) when (ex.ErrorCode == "NoSuchUpload") { /* Already completed or aborted. */ }
        }
        await client.Value.DeleteObjectAsync(Bucket, key, ct);
    }

    public void Dispose() { if (client.IsValueCreated) client.Value.Dispose(); }
}
