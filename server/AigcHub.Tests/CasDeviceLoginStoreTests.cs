using AigcHub.Api.Domain;
using AigcHub.Api.Services;

namespace AigcHub.Tests;

public sealed class CasDeviceLoginStoreTests
{
    [Fact]
    public void CompletedLoginCanBeReadAgainAfterLostResponse()
    {
        var store = new CasDeviceLoginStore();
        var code = store.Create();
        Assert.Null(store.ReadResult(code, out var pending));
        Assert.True(pending);
        var result = new DshLoginResult(new string('a', 64), new string('b', 64),
            DateTimeOffset.UtcNow.AddMinutes(10), new DshLoginUser(Guid.NewGuid(), "wh00028"));
        Assert.True(store.Complete(code, result));
        Assert.Equal(result, store.ReadResult(code, out pending));
        Assert.False(pending);
        Assert.Equal(result, store.ReadResult(code, out pending));
        Assert.False(pending);
        Assert.Null(store.ReadResult("missing", out pending));
        Assert.False(pending);
    }

    [Fact]
    public async Task ConcurrentPollingDoesNotConsumeAnotherClientsLoginResult()
    {
        var store = new CasDeviceLoginStore();
        var requests = Enumerable.Range(0, 1000).Select(index =>
        {
            var code = store.Create();
            var result = new DshLoginResult($"access-{index}", $"refresh-{index}",
                DateTimeOffset.UtcNow.AddMinutes(10), new DshLoginUser(Guid.NewGuid(), $"user-{index}"));
            Assert.True(store.Complete(code, result));
            return (code, result);
        }).ToArray();
        await Parallel.ForEachAsync(requests, new ParallelOptions { MaxDegreeOfParallelism = 32 }, (request, _) =>
        {
            for (var retry = 0; retry < 16; retry++)
            {
                Assert.Equal(request.result, store.ReadResult(request.code, out var pending));
                Assert.False(pending);
            }
            return ValueTask.CompletedTask;
        });
    }
}
