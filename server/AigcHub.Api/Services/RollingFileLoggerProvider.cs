using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace AigcHub.Api.Services;

public sealed class FileLogOptions
{
    public bool Enabled { get; set; } = true;
    public string Directory { get; set; } = "App_Data/logs";
    public long MaxFileSizeBytes { get; set; } = 20 * 1024 * 1024;
    public int MaxFiles { get; set; } = 50;
    public int RetentionDays { get; set; } = 14;
}

/// <summary>Bounded JSONL archive. Writes are serialized and flushed before returning.</summary>
public sealed class RollingFileLoggerProvider : ILoggerProvider, ISupportExternalScope
{
    private readonly FileLogOptions options;
    private readonly object gate = new();
    private IExternalScopeProvider scopes = new LoggerExternalScopeProvider();
    private FileStream? stream;
    private DateOnly day;
    private string? current;
    private DateTimeOffset nextCleanup;
    private DateTimeOffset retryAfter;
    private bool disposed;

    public RollingFileLoggerProvider(FileLogOptions options)
    {
        if (options.MaxFileSizeBytes < 64 * 1024 || options.MaxFiles < 1 || options.RetentionDays < 1)
            throw new ArgumentException("FileLogging requires MaxFileSizeBytes >= 65536, MaxFiles >= 1 and RetentionDays >= 1");
        this.options = options;
        if (!options.Enabled) return;
        options.Directory = Path.GetFullPath(options.Directory);
        Directory.CreateDirectory(options.Directory);
        // Fail startup clearly when the configured archive mount is not writable.
        var probe = Path.Combine(options.Directory, $".write-test-{Guid.NewGuid():N}");
        using (File.Create(probe)) { }
        File.Delete(probe);
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);
    public void SetScopeProvider(IExternalScopeProvider scopeProvider) => scopes = scopeProvider;
    public void Dispose() { lock (gate) { disposed = true; stream?.Dispose(); stream = null; } }

    private static string? Limit(string? value, int length)
    {
        if (value is null) return null;
        value = Regex.Replace(value, @"(?i)(/auth/cas/device/)[^/?\s\""']+", "$1[REDACTED]");
        value = Regex.Replace(value, @"(?i)\bBearer\s+[a-z0-9._~+/=-]+", "Bearer [REDACTED]");
        value = Regex.Replace(value, @"(?i)(ticket|access_token|refresh_token|api_key|password|authorization|portal_state|device_code)(\s*[=:]\s*)[^\s&\""',;]+", "$1$2[REDACTED]");
        return value.Length > length ? value[..length] + " [truncated]" : value;
    }

    private static string? Field(string key, object? value) => Regex.IsMatch(key,
        "(?i)password|token|secret|authorization|cookie|ticket|api.?key|portal_state|device_code")
        ? "[REDACTED]" : Limit(value?.ToString(), 512);

    private void Write<TState>(string category, LogLevel level, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var scopeData = new List<object?>();
        scopes.ForEachScope((scope, target) =>
        {
            if (scope is IEnumerable<KeyValuePair<string, object?>> values)
                target.Add(values.Take(32).ToDictionary(x => x.Key, x => (object?)Field(x.Key, x.Value)));
            else target.Add(Limit(scope?.ToString(), 1024));
        }, scopeData);
        var now = DateTimeOffset.UtcNow;
        var record = new
        {
            Timestamp = now, LogLevel = level.ToString(), Category = category, EventId = eventId.Id,
            Message = Limit(formatter(state, exception), 12000), Exception = Limit(exception?.ToString(), 24000),
            State = state is IEnumerable<KeyValuePair<string, object?>> fields
                ? fields.Take(32).ToDictionary(x => x.Key, x => Field(x.Key, x.Value)) : null,
            Scopes = scopeData.Take(16)
        };
        // JSON encoding can expand control characters; cap the actual byte count too.
        var bytes = JsonSerializer.SerializeToUtf8Bytes(record);
        if (bytes.Length + 1 > options.MaxFileSizeBytes)
            bytes = JsonSerializer.SerializeToUtf8Bytes(new { Timestamp = now, LogLevel = level.ToString(), Category = Limit(category, 512),
                Message = "Oversized log entry omitted", Scopes = scopeData.OfType<Dictionary<string, object?>>()
                    .SelectMany(x => x).Where(x => x.Key is "TraceId" or "UserId" or "EmployeeNo").Take(6).ToArray() });
        lock (gate)
        {
            if (disposed) return;
            Console.WriteLine(Encoding.UTF8.GetString(bytes));
            if (!options.Enabled || now < retryAfter) return;
            try
            {
                var today = DateOnly.FromDateTime(now.UtcDateTime);
                if (stream is null || today != day || stream.Length + bytes.Length + 1 > options.MaxFileSizeBytes)
                {
                    stream?.Dispose();
                    stream = null;
                    current = Path.Combine(options.Directory, $"aigc-{today:yyyyMMdd}-{Environment.ProcessId}-{Guid.NewGuid():N}.jsonl");
                    stream = new FileStream(current, FileMode.CreateNew, FileAccess.Write, FileShare.Read | FileShare.Delete);
                    day = today;
                    Cleanup(now);
                }
                else if (now >= nextCleanup) Cleanup(now);
                stream.Write(bytes);
                stream.WriteByte((byte)'\n');
                stream.Flush();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                stream?.Dispose();
                stream = null;
                retryAfter = now.AddSeconds(30);
                Console.Error.WriteLine($"AIGC file log archive unavailable: {error.GetType().Name}; directory={options.Directory}; console logging remains active");
            }
        }
    }

    private void Cleanup(DateTimeOffset now)
    {
        nextCleanup = now.AddMinutes(10);
        var files = new DirectoryInfo(options.Directory).GetFiles("aigc-*.jsonl")
            .OrderByDescending(x => x.LastWriteTimeUtc).ThenByDescending(x => x.Name).ToArray();
        var keep = options.MaxFiles - 1;
        foreach (var file in files.Where(x => x.FullName != current))
        {
            if (file.LastWriteTimeUtc < now.AddDays(-options.RetentionDays).UtcDateTime || keep-- <= 0)
                file.Delete();
        }
    }

    private sealed class FileLogger(RollingFileLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => owner.scopes.Push(state);
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (IsEnabled(logLevel)) owner.Write(category, logLevel, eventId, state, exception, formatter);
        }
    }
}
