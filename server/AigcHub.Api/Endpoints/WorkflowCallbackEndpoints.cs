using System.Security.Cryptography;
using System.Text;
using AigcHub.Api.Contracts;
using AigcHub.Api.Services;

namespace AigcHub.Api.Endpoints;

public static class WorkflowCallbackEndpoints
{
    public static void MapWorkflowCallbackEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/workflow/callbacks/application-publish", ReceiveAsync)
            .AllowAnonymous().WithTags("流程回调");
    }

    private static async Task<IResult> ReceiveAsync(CallbackRequest input, HttpRequest request,
        WorkflowService workflow, IConfiguration config, CancellationToken ct)
    {
        var timestamp = request.Headers["X-Callback-Timestamp"].ToString();
        var signature = request.Headers["X-Callback-Signature"].ToString();
        if (!long.TryParse(timestamp, out var unix) ||
            Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - unix) > 300)
            return Results.Unauthorized();

        var secret = config["Callback:Secret"] ?? "development-callback-secret";
        var content = $"{timestamp}.{input.EventId}.{input.CorrelationId}.{input.Status}";
        var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(signature)))
            return Results.Unauthorized();
        return Results.Ok(await workflow.ReceiveCallbackAsync(input, ct));
    }
}
