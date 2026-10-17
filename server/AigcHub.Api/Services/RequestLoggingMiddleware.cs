using System.Diagnostics;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Services;

/// <summary>One correlation scope for all application logs emitted during a request.</summary>
public sealed class RequestLoggingMiddleware(RequestDelegate next, ILogger<RequestLoggingMiddleware> logger)
{
    private static readonly object UserScopeKey = new();
    public static void Identify(HttpContext context, Guid id, string employeeNo, string name)
    {
        if (context.Items.TryGetValue(UserScopeKey, out var value) && value is Dictionary<string, object?> fields)
        {
            fields["UserId"] = id;
            fields["EmployeeNo"] = employeeNo;
            fields["UserName"] = name;
        }
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var traceId = Activity.Current?.TraceId.ToString() ?? context.TraceIdentifier;
        context.Response.Headers["X-Trace-Id"] = traceId;
        var fields = new Dictionary<string, object?>
        {
            ["TraceId"] = traceId,
            ["RequestId"] = context.TraceIdentifier,
            ["Method"] = context.Request.Method,
            // Query strings may contain CAS tickets, tokens or user input.
            ["Path"] = context.Request.Path.Value,
            ["UserId"] = context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "anonymous",
            ["EmployeeNo"] = context.User.FindFirstValue("employee_no"),
            ["UserName"] = context.User.FindFirstValue(ClaimTypes.Name)
        };
        context.Items[UserScopeKey] = fields;
        using var scope = logger.BeginScope(fields);
        var started = Stopwatch.GetTimestamp();
        var aborted = false;
        try { await next(context); }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            aborted = true;
            logger.LogWarning("Client disconnected or cancelled the request");
            if (!context.Response.HasStarted) context.Response.StatusCode = 499;
        }
        catch (Exception exception)
        {
            var status = exception switch
            {
                WorkflowException workflow => workflow.StatusCode,
                DbUpdateConcurrencyException => 409,
                BadHttpRequestException badRequest => badRequest.StatusCode,
                _ => 500
            };
            logger.Log(status >= 500 ? LogLevel.Error : LogLevel.Warning, exception,
                "Request failed with {StatusCode}; responseStarted={ResponseStarted}", status, context.Response.HasStarted);
            if (context.Response.HasStarted) throw;
            context.Response.Clear();
            context.Response.Headers["X-Trace-Id"] = traceId;
            var detail = exception switch
            {
                WorkflowException workflow => workflow.Message,
                DbUpdateConcurrencyException => "数据已被其他用户修改，请刷新后重试",
                _ => "请求处理失败，请联系管理员并提供追踪 ID"
            };
            await Results.Problem(detail, statusCode: status,
                extensions: new Dictionary<string, object?> { ["traceId"] = traceId }).ExecuteAsync(context);
        }
        finally
        {
            var status = context.Response.StatusCode;
            // Successful probes are noisy and carry no user activity.
            var level = aborted || status >= 400 ? (status >= 500 ? LogLevel.Error : LogLevel.Warning)
                : context.Request.Path == "/health" ? LogLevel.Debug : LogLevel.Information;
            logger.Log(level, "HTTP request completed {StatusCode} in {ElapsedMs} ms; aborted={Aborted}",
                status, Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 2), aborted);
        }
    }
}
