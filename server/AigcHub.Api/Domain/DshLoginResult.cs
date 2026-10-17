using System.Text.Json.Serialization;

namespace AigcHub.Api.Domain;

public sealed record DshLoginUser(Guid Id, string Username);
public sealed record DshLoginResult(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("refresh_token")] string RefreshToken,
        [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt,
        DshLoginUser User);
