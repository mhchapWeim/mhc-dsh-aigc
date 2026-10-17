using System.Collections.Concurrent;
using AigcHub.Api.Domain;
using System.Security.Cryptography;

namespace AigcHub.Api.Services;

public sealed class CasDeviceLoginStore
{
    private sealed record Entry(DateTimeOffset ExpiresAt, DshLoginResult? Result = null);

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public string Create()
    {
        RemoveExpired();
        var code = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        _entries[code] = new Entry(DateTimeOffset.UtcNow.AddMinutes(5));
        return code;
    }

    public bool Exists(string code)
    {
        RemoveExpired();
        return _entries.ContainsKey(code);
    }

    public bool Complete(string code, DshLoginResult result)
    {
        RemoveExpired();
        return _entries.TryGetValue(code, out var current)
            && _entries.TryUpdate(code, current with { Result = result }, current);
    }

    public DshLoginResult? ReadResult(string code, out bool pending)
    {
        RemoveExpired();
        pending = false;
        if (!_entries.TryGetValue(code, out var current)) return null;
        if (current.Result is null)
        {
            pending = true;
            return null;
        }
        // Keep the result until expiry so a lost response or a local write failure can be retried.
        return current.Result;
    }

    private void RemoveExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in _entries)
            if (entry.Value.ExpiresAt <= now) _entries.TryRemove(entry.Key, out _);
    }
}
