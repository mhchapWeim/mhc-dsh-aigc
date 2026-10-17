using System.Security.Claims;
using System.Text.Json;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace AigcHub.Tests;

public sealed class RequestLoggingTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "aigc-log-tests-" + Guid.NewGuid().ToString("N"));
    private readonly List<RollingFileLoggerProvider> providers = [];
    private ILoggerFactory Factory(long size = 65536, int count = 3)
    {
        var provider = new RollingFileLoggerProvider(new FileLogOptions
            { Directory = directory, MaxFileSizeBytes = size, MaxFiles = count, RetentionDays = 14 });
        providers.Add(provider);
        return LoggerFactory.Create(builder => builder.AddProvider(provider));
    }
    private void CloseArchives() { foreach (var provider in providers) provider.Dispose(); }

    [Fact]
    public async Task ExceptionArchiveContainsVerifiedIdentityStackAndCorrelatedSafeResponse()
    {
        using var factory = Factory();
        using var services = new ServiceCollection().AddLogging().AddOptions().BuildServiceProvider();
        var context = new DefaultHttpContext { RequestServices = services };
        context.Response.Body = new MemoryStream();
        context.Request.Path = "/api/test";
        context.Request.QueryString = new QueryString("?ticket=never-log-ticket");
        context.User = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim(ClaimTypes.NameIdentifier, "user-123"), new Claim("employee_no", "employee123"), new Claim(ClaimTypes.Name, "测试用户") }, "test"));
        var middleware = new RequestLoggingMiddleware(_ => throw new InvalidOperationException("test failure"), factory.CreateLogger<RequestLoggingMiddleware>());
        await middleware.InvokeAsync(context);
        Assert.Equal(500, context.Response.StatusCode);
        var trace = context.Response.Headers["X-Trace-Id"].ToString();
        context.Response.Body.Position = 0;
        var body = await new StreamReader(context.Response.Body).ReadToEndAsync();
        Assert.Contains(trace, body);
        Assert.DoesNotContain("test failure", body);
        CloseArchives();
        var records = Directory.GetFiles(directory).SelectMany(File.ReadAllLines).Select(line => JsonDocument.Parse(line)).ToArray();
        Assert.Contains(records, r => r.RootElement.GetProperty("Exception").GetString()?.Contains("InvalidOperationException") == true);
        var archive = string.Join("\n", Directory.GetFiles(directory).Select(File.ReadAllText));
        Assert.Contains("employee123", archive);
        Assert.Contains("user-123", archive);
        Assert.Contains(trace, archive);
        Assert.DoesNotContain("never-log-ticket", archive);
    }

    [Fact]
    public void RotationAndRestartPruneOldFilesAndKeepEachFileBounded()
    {
        Directory.CreateDirectory(directory);
        var expired = Path.Combine(directory, "aigc-expired.jsonl");
        File.WriteAllText(expired, "expired");
        File.SetLastWriteTimeUtc(expired, DateTime.UtcNow.AddDays(-15));
        for (var run = 0; run < 2; run++)
        {
            using var factory = Factory();
            var logger = factory.CreateLogger("rotation");
            Parallel.For(0, 50, index => logger.LogInformation("Item {Index} {Content}", index, new string('x', 4000)));
            logger.LogWarning("Oversized {Content}", new string('\u0001', 100000));
            CloseArchives();
        }
        Assert.False(File.Exists(expired));
        var files = new DirectoryInfo(directory).GetFiles("aigc-*.jsonl");
        Assert.InRange(files.Length, 1, 3);
        Assert.All(files, file => {
            Assert.InRange(file.Length, 1, 65536);
            Assert.All(File.ReadLines(file.FullName), line => { using var json = JsonDocument.Parse(line); Assert.True(json.RootElement.TryGetProperty("Timestamp", out _)); });
        });
    }

    [Fact]
    public async Task CancellationAndAuthorizationFailureRemainVisibleWithoutBecoming500()
    {
        using var factory = Factory();
        var context = new DefaultHttpContext();
        context.RequestAborted = new CancellationToken(true);
        await new RequestLoggingMiddleware(_ => throw new OperationCanceledException(), factory.CreateLogger<RequestLoggingMiddleware>()).InvokeAsync(context);
        Assert.Equal(499, context.Response.StatusCode);
        var denied = new DefaultHttpContext();
        await new RequestLoggingMiddleware(c => { c.Response.StatusCode = 403; return Task.CompletedTask; }, factory.CreateLogger<RequestLoggingMiddleware>()).InvokeAsync(denied);
        Assert.Equal(403, denied.Response.StatusCode);
        CloseArchives();
        Assert.Contains("anonymous", File.ReadAllText(Directory.GetFiles(directory).Single()));
    }

    [Fact]
    public void SensitiveUrlAndStructuredFieldsAreRedacted()
    {
        using var factory = Factory();
        var logger = factory.CreateLogger("security");
        logger.LogWarning("CAS URL https://sso/cas?ticket=SECRET123&service=x Password={Password} Authorization=Bearer ABCDEF", "hidden-password");
        CloseArchives();
        var archive = File.ReadAllText(Directory.GetFiles(directory).Single());
        Assert.DoesNotContain("SECRET123", archive);
        Assert.DoesNotContain("hidden-password", archive);
        Assert.DoesNotContain("ABCDEF", archive);
        Assert.Contains("REDACTED", archive);
    }

    public void Dispose() { CloseArchives(); if (Directory.Exists(directory)) Directory.Delete(directory, true); }
}
