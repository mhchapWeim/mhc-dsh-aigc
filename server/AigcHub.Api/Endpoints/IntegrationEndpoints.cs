using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Endpoints;

public static class IntegrationEndpoints
{
    public sealed record ServiceInput(string Code, string Name, string Kind, bool IsEnabled, string ConnectionKey, IntegrationOperation[] Operations);
    public sealed record OAuthInput(Guid State, string Code);
    public sealed record CompleteDeploymentInput(string DeploymentUrl);

    public static void MapIntegrationEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/integrations").RequireAuthorization("process.design");
        admin.MapGet("/", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(await db.IntegrationServices.AsNoTracking().OrderBy(x => x.Code).ToListAsync(ct)));
        admin.MapPut("/{code}", SaveAsync);
        admin.MapGet("/invocations", async (int? page, AigcHubDbContext db, CancellationToken ct) => {
            var query = db.IntegrationInvocations.AsNoTracking();
            var now = DateTimeOffset.UtcNow;
            return Results.Ok(new { items = await query.OrderByDescending(x => x.ExpiresAt).Skip((Math.Max(1, page ?? 1) - 1) * 20).Take(20)
                .Select(x => new
                {
                    x.Id, x.InstanceId, x.NodeKey, x.ServiceCode, x.Operation, x.Status, x.Attempts, x.ExpiresAt,
                    CanTriggerDeployment = x.ServiceCode == IntegrationWorkflowRunner.DeploymentServiceCode &&
                        x.ResultEvent == IntegrationWorkflowRunner.DeploymentCompletedEvent && x.Protocol == "generic-v1" &&
                        (x.Status == "Pending" || x.Status == "Sent" || x.Status == "DeliveryFailed") && x.ExpiresAt > now &&
                        db.WorkflowInstances.Any(instance => instance.Id == x.InstanceId &&
                            instance.Status == WorkflowInstanceStatus.WaitingCallback && instance.CurrentNodeKey == x.NodeKey)
                }).ToListAsync(ct), total = await query.CountAsync(ct) });
        });
        admin.MapPost("/invocations/{id:guid}/complete-deployment", async (Guid id, CompleteDeploymentInput input,
            ICurrentUser current, IntegrationWorkflowRunner runner, CancellationToken ct) =>
            Results.Ok(new { duplicate = await runner.CompleteDeploymentManuallyAsync(id, input.DeploymentUrl, current.Id, ct) }));
        admin.MapPost("/invocations/{id:guid}/retry", async (Guid id, AigcHubDbContext db, ICurrentUser current, CancellationToken ct) => {
            var call = await db.IntegrationInvocations.SingleOrDefaultAsync(x => x.Id == id, ct);
            if (call is null) return Results.NotFound();
            var instance = await db.WorkflowInstances.SingleAsync(x => x.Id == call.InstanceId, ct);
            if (call.Status != "DeliveryFailed" || call.ExpiresAt <= DateTimeOffset.UtcNow || instance.Status != WorkflowInstanceStatus.WaitingCallback || instance.CurrentNodeKey != call.NodeKey)
                return Results.Conflict(new { message = "只能重试当前节点尚未过期的投递失败调用" });
            call.Status = "Pending"; call.Attempts = 0; call.NextAttemptAt = DateTimeOffset.UtcNow; call.ConcurrencyToken = Guid.NewGuid();
            db.WorkflowHistory.Add(new WorkflowHistory { InstanceId = call.InstanceId, NodeKey = call.NodeKey, ActorId = current.Id, EventType = "ServiceDeliveryRetry", Detail = id.ToString() });
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        var gitea = app.MapGroup("/api/code-sources/gitea").RequireAuthorization("publication.create");
        gitea.MapGet("/services", async (AigcHubDbContext db, CancellationToken ct) => Results.Ok(await db.IntegrationServices.Where(x => x.Kind == "Gitea" && x.IsEnabled).Select(x => new { x.Code, x.Name }).ToListAsync(ct)));
        gitea.MapGet("/{service}/connection", async (string service, AigcHubDbContext db, ICurrentUser current, CancellationToken ct) =>
            Results.Ok(await db.GiteaConnections.Where(x => x.ServiceCode == service && x.UserId == current.Id).Select(x => new { x.Login, x.ExternalUserId }).SingleOrDefaultAsync(ct)));
        gitea.MapPost("/{service}/authorize", async (string service, GiteaService client, ICurrentUser current, CancellationToken ct) => Results.Ok(new { url = await client.AuthorizeAsync(current.Id, service, ct) }));
        gitea.MapPost("/complete", async (OAuthInput input, GiteaService client, ICurrentUser current, CancellationToken ct) => { await client.CompleteAsync(current.Id, input.State, input.Code, ct); return Results.NoContent(); });
        gitea.MapDelete("/{service}/connection", async (string service, AigcHubDbContext db, ICurrentUser current, CancellationToken ct) => {
            var connection = await db.GiteaConnections.SingleOrDefaultAsync(x => x.ServiceCode == service && x.UserId == current.Id, ct);
            if (connection is not null) { db.Remove(connection); await db.SaveChangesAsync(ct); }
            return Results.NoContent();
        });
        gitea.MapGet("/{service}/repositories", async (string service, int? page, GiteaService client, ICurrentUser current, CancellationToken ct) =>
            Results.Ok(await client.GetAsync(current.Id, service, $"user/repos?page={Math.Max(1, page ?? 1)}&limit=50", ct)));
        gitea.MapGet("/{service}/repositories/{id:long}/{kind}", async (string service, long id, string kind, string? reference, int? page, GiteaService client, ICurrentUser current, CancellationToken ct) =>
            Results.Ok(await client.RepositoryDataAsync(current.Id, service, id, kind, reference, page ?? 1, ct)));

        app.MapPost("/api/workflow/integration-callbacks/{service}", CallbackAsync).AllowAnonymous();
    }

    private static async Task<IResult> SaveAsync(string code, ServiceInput input, AigcHubDbContext db, IConfiguration config, CancellationToken ct)
    {
        if (code != input.Code || !Regex.IsMatch(code, "^[a-z][a-z0-9-]{1,79}$") || string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 150 ||
            input.Kind is not ("Gitea" or "Mq") || !Regex.IsMatch(input.ConnectionKey, "^[A-Za-z][A-Za-z0-9_-]{0,79}$"))
            return Results.BadRequest(new { message = "服务标识、类型或连接配置引用无效" });
        if (input.Operations is null || input.Operations.Length > 30 || input.Operations.Any(x => x is null || string.IsNullOrWhiteSpace(x.Code) || string.IsNullOrWhiteSpace(x.ResultEvent) ||
            x.Protocol is not ("generic-v1" or CodeReviewProtocol.Name) || (x.Protocol == CodeReviewProtocol.Name || x.Code == "review.requested") && (x.Code != "review.requested" || x.ResultEvent != "review.finished")) || input.Operations.DistinctBy(x => x.Code).Count() != input.Operations.Length)
            return Results.BadRequest(new { message = "操作编码及结果事件不能为空或重复" });
        if (input.IsEnabled && !config.GetSection($"IntegrationConnections:{input.ConnectionKey}").Exists())
            return Results.BadRequest(new { message = "请先在服务端配置对应连接，再启用服务" });
        var service = await db.IntegrationServices.SingleOrDefaultAsync(x => x.Code == code, ct);
        if (service is null) { service = new IntegrationService { Code = code }; db.Add(service); }
        if (await db.IntegrationInvocations.AnyAsync(x => x.ServiceCode == code && (x.Status == "Pending" || x.Status == "Sent" || x.Status == "DeliveryFailed"), ct)
            && (!input.IsEnabled || input.ConnectionKey != service.ConnectionKey || input.Kind != service.Kind))
            return Results.Conflict(new { message = "服务存在等待结果的调用，暂不能停用或更换连接" });
        if (await db.GiteaConnections.AnyAsync(x => x.ServiceCode == code, ct) && (input.ConnectionKey != service.ConnectionKey || input.Kind != service.Kind))
            return Results.Conflict(new { message = "服务存在用户授权，不能更换连接或类型，请新建服务标识" });
        if (service.Kind != input.Kind && await db.IntegrationInvocations.AnyAsync(x => x.ServiceCode == code, ct))
            return Results.Conflict(new { message = "已有调用记录的服务不可更改类型" });
        service.Name = input.Name.Trim(); service.Kind = input.Kind; service.ConnectionKey = input.ConnectionKey;
        service.IsEnabled = input.IsEnabled; service.OperationsJson = JsonSerializer.Serialize(input.Operations, IntegrationWorkflowRunner.JsonOptions);
        await db.SaveChangesAsync(ct);
        return Results.Ok(service);
    }

    private static async Task<IResult> CallbackAsync(string service, HttpRequest request, AigcHubDbContext db,
        IConfiguration config, IntegrationWorkflowRunner runner, CancellationToken ct)
    {
        var definition = await db.IntegrationServices.SingleOrDefaultAsync(x => x.Code == service && x.Kind == "Mq" && x.IsEnabled, ct);
        if (definition is null) return Results.Unauthorized();
        var secret = config[$"IntegrationConnections:{definition.ConnectionKey}:CallbackSecret"];
        if (string.IsNullOrWhiteSpace(secret) || !long.TryParse(request.Headers["X-Callback-Timestamp"], out var timestamp) || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - timestamp) > 300)
            return Results.Unauthorized();
        // Bound body size even for chunked requests; sign the complete raw UTF-8 body.
        using var buffer = new MemoryStream();
        var bytes = new byte[8192]; int read;
        while ((read = await request.Body.ReadAsync(bytes, ct)) > 0) {
            if (buffer.Length + read > 262144) return Results.StatusCode(413);
            buffer.Write(bytes, 0, read);
        }
        var body = Encoding.UTF8.GetString(buffer.ToArray());
        var expected = "sha256=" + Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{timestamp}.{body}"))).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(request.Headers["X-Callback-Signature"].ToString()))) return Results.Unauthorized();
        IntegrationResult? result;
        try { result = JsonSerializer.Deserialize<IntegrationResult>(body, IntegrationWorkflowRunner.JsonOptions); }
        catch (JsonException) { return Results.BadRequest(new { message = "回调格式无效" }); }
        if (result is null) return Results.BadRequest();
        return Results.Ok(new { duplicate = await runner.ReceiveAsync(service, result, ct) });
    }
}
