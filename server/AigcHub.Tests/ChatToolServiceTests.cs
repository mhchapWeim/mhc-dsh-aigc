using System.Text.Json;
using System.Net;
using System.Text;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public sealed class ChatToolServiceTests
{
    [Fact]
    public async Task Write_tool_requires_confirmation_before_persisting()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var conversation = new ChatConversation { UserId = admin.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new CreateCategoryTool(db)], permissions);
        var service = new ChatToolExecutionService(db, registry, permissions);
        var arguments = JsonSerializer.SerializeToElement(new
        {
            code = "chat-test", name = "Chat 工具测试", description = "", color = "#2465d0", sortOrder = 99, isEnabled = true
        });

        var proposed = await service.ProposeAsync(admin.Id, conversation.Id, "create_category", arguments, default);

        Assert.False(await db.Categories.AnyAsync(x => x.Code == "chat-test"));
        Assert.Contains("AwaitingConfirmation", JsonSerializer.Serialize(proposed));
        var pending = await service.ListPendingAsync(admin.Id, conversation.Id, default);
        Assert.Single(pending);
        Assert.Contains("AwaitingConfirmation", JsonSerializer.Serialize(pending));

        var executionId = await db.ChatToolExecutions.Select(x => x.Id).SingleAsync();
        await service.ConfirmAsync(admin.Id, executionId, default);

        Assert.True(await db.Categories.AnyAsync(x => x.Code == "chat-test"));
        Assert.Equal(ChatToolExecutionStatus.Succeeded, (await db.ChatToolExecutions.SingleAsync()).Status);
        Assert.True((await db.OperationAudits.SingleAsync()).Succeeded);
    }

    [Fact]
    public async Task Tool_registry_and_execution_use_current_database_permissions()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var normal = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var conversation = new ChatConversation { UserId = normal.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new CreateCategoryTool(db)], permissions);
        var service = new ChatToolExecutionService(db, registry, permissions);
        var arguments = JsonSerializer.SerializeToElement(new { code = "denied", name = "无权分类" });

        Assert.Empty(await registry.AvailableAsync(normal.Id, default));
        var error = await Assert.ThrowsAsync<WorkflowException>(() =>
            service.ProposeAsync(normal.Id, conversation.Id, "create_category", arguments, default));

        Assert.Equal(403, error.StatusCode);
        Assert.False(await db.Categories.AnyAsync(x => x.Code == "denied"));
    }

    [Fact]
    public async Task Sensitive_tool_arguments_are_redacted_from_responses_and_audits()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var conversation = new ChatConversation { UserId = admin.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry(
            [new CreateUserTool(db, new PasswordHasher<AppUser>())], permissions);
        var service = new ChatToolExecutionService(db, registry, permissions);
        const string password = "Temporary@123";
        var arguments = JsonSerializer.SerializeToElement(new
        {
            employeeNo = "chat-user", name = "工具用户", email = "chat-user@example.com",
            department = "DIGITAL", roles = new[] { "normal-user" }, initialPassword = password, isEnabled = true
        });

        var proposed = await service.ProposeAsync(admin.Id, conversation.Id, "create_user", arguments, default);
        Assert.DoesNotContain(password, JsonSerializer.Serialize(proposed));

        var executionId = await db.ChatToolExecutions.Select(x => x.Id).SingleAsync();
        await service.ConfirmAsync(admin.Id, executionId, default);

        Assert.True(await db.Users.AnyAsync(x => x.EmployeeNo == "chat-user"));
        Assert.DoesNotContain(password, (await db.OperationAudits.SingleAsync()).DetailJson);
    }

    [Fact]
    public async Task Category_tool_generates_optional_defaults()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var conversation = new ChatConversation { UserId = admin.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new CreateCategoryTool(db)], permissions);
        var service = new ChatToolExecutionService(db, registry, permissions);

        await service.ProposeAsync(admin.Id, conversation.Id, "create_category",
            JsonSerializer.SerializeToElement(new { name = "Demo Defaults" }), default);
        var executionId = await db.ChatToolExecutions.Select(x => x.Id).SingleAsync();
        await service.ConfirmAsync(admin.Id, executionId, default);

        var category = await db.Categories.SingleAsync(x => x.Name == "Demo Defaults");
        Assert.Equal("demo-defaults", category.Code);
        Assert.Equal("#2465d0", category.Color);
        Assert.True(category.SortOrder > 0);
        Assert.True(category.IsEnabled);
    }

    [Fact]
    public void Category_confirmation_preview_lists_provided_and_default_values()
    {
        using var document = JsonDocument.Parse("""{"name":"Demo","description":"测试"}""");
        using var db = CreateDb();
        var definition = new CreateCategoryTool(db).Definition;

        var preview = ChatOrchestrator.BuildConfirmationPreview(definition, document.RootElement);

        Assert.Contains("| 分类名称 | Demo |", preview);
        Assert.Contains("| 分类编码 | 自动生成 |", preview);
        Assert.Contains("| 描述 | 测试 |", preview);
        Assert.Contains("| 主题色 | #2465d0（默认） |", preview);
        Assert.Contains("| 排序 | 现有分类末尾（默认） |", preview);
        Assert.Contains("回复“确认”", preview);
    }

    [Fact]
    public async Task Context_selector_uses_latest_messages_and_preserves_current_request()
    {
        await using var db = CreateDb();
        var conversation = new ChatConversation { UserId = Guid.NewGuid() };
        db.ChatConversations.Add(conversation);
        var start = new DateTimeOffset(2026, 9, 15, 8, 0, 0, TimeSpan.Zero);
        for (var index = 0; index < 40; index++)
            db.ChatMessages.Add(new ChatMessage
            {
                Conversation = conversation, Role = index % 2 == 0 ? "user" : "assistant",
                Content = $"旧消息-{index}", CreatedAt = start.AddMinutes(index)
            });
        var current = new ChatMessage
        {
            Conversation = conversation, Role = "user", Content = "打开 ancc应用",
            CreatedAt = start.AddMinutes(41)
        };
        db.ChatMessages.Add(current);
        await db.SaveChangesAsync();

        var history = await ChatContextSelector.LoadRecentAsync(db, conversation.Id, current.Id, 30, default);

        Assert.Equal(30, history.Count);
        Assert.Equal("旧消息-11", history[0].Content);
        Assert.Equal("打开 ancc应用", history[^1].Content);
        Assert.DoesNotContain(history, item => item.Content == "旧消息-0");
    }

    [Theory]
    [InlineData("打开 ancc应用", "open_application")]
    [InlineData("帮我打开 abc 这个app", "open_application")]
    [InlineData("帮我创建名为 Demo 的应用分类", "create_category")]
    [InlineData("新建发布申请", "create_publication_request")]
    [InlineData("如何打开应用？", null)]
    public void Explicit_intent_routes_to_only_the_requested_tool(string content, string? expected)
    {
        Assert.Equal(expected, ChatIntentRouter.ResolveToolName(content));
    }

    [Theory]
    [InlineData("打开 ancc应用", "ancc")]
    [InlineData("帮我打开 abc 这个app", "abc")]
    [InlineData("打开某个应用", null)]
    public void Named_app_command_extracts_only_a_concrete_target(string content, string? expected)
    {
        Assert.Equal(expected, ChatIntentRouter.ExtractApplicationName(content));
    }

    [Fact]
    public void Named_app_command_rejects_model_arguments_for_another_app()
    {
        Assert.False(ChatIntentRouter.MatchesApplicationName("ancc",
            JsonSerializer.SerializeToElement(new { applicationName = "abc" })));
        Assert.True(ChatIntentRouter.MatchesApplicationName("ancc",
            JsonSerializer.SerializeToElement(new { applicationName = "ancc" })));
    }

    [Fact]
    public async Task Opening_app_cancels_stale_category_request_and_rejects_wrong_model_tool()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var modelConfiguration = new AiModelConfiguration
        {
            Name = "测试模型", BaseUrl = "http://model.test", ModelIdentifier = "stub",
            AuthType = "None", SupportsTools = true, IsEnabled = true, IsDefault = true
        };
        db.ModelConfigurations.Add(modelConfiguration);
        db.UserModelGrants.Add(new UserModelGrant { UserId = admin.Id, ModelId = modelConfiguration.Id });
        var conversation = new ChatConversation { UserId = admin.Id, ModelConfigurationId = modelConfiguration.Id };
        db.ChatConversations.Add(conversation);
        var start = DateTimeOffset.UtcNow.AddHours(-2);
        for (var index = 0; index < 35; index++)
            db.ChatMessages.Add(new ChatMessage
            {
                Conversation = conversation, Role = index % 2 == 0 ? "user" : "assistant",
                Content = $"创建 demo3 分类的旧消息-{index}", CreatedAt = start.AddMinutes(index)
            });
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new CreateCategoryTool(db), new OpenApplicationTool(db)], permissions);
        var executions = new ChatToolExecutionService(db, registry, permissions);
        await executions.ProposeAsync(admin.Id, conversation.Id, "create_category",
            JsonSerializer.SerializeToElement(new { name = "demo3" }), default);
        var handler = new StubModelHandler();
        var models = new ModelConfigurationService(db, DataProtectionProvider.Create("AigcHub.Tests"),
            Options.Create(new ChatOptions()));
        var orchestrator = new ChatOrchestrator(db, registry, executions,
            new ChatModelClient(new StubHttpClientFactory(handler), models));

        var response = await orchestrator.SendAsync(admin.Id, conversation.Id, "打开 ancc应用", modelConfiguration.Id, default);
        using var responseJson = JsonDocument.Parse(JsonSerializer.Serialize(response));

        Assert.Contains("与当前请求不符", responseJson.RootElement.GetProperty("message").GetProperty("Content").GetString());
        Assert.Equal(JsonValueKind.Null, responseJson.RootElement.GetProperty("toolExecution").ValueKind);
        Assert.Equal(ChatToolExecutionStatus.Cancelled, (await db.ChatToolExecutions.SingleAsync()).Status);
        Assert.False(await db.Categories.AnyAsync(x => x.Name == "demo3"));
        Assert.Single(handler.ToolNames);
        Assert.Equal("open_application", handler.ToolNames[0]);
        Assert.Contains("打开 ancc应用", handler.MessageContents);
        Assert.Equal(2, handler.MessageContents.Count); // 系统提示 + 当前用户指令，旧分类内容不进入此操作。
    }

    [Fact]
    public async Task Opening_named_app_does_not_run_tool_if_model_returns_another_app_name()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var modelConfiguration = new AiModelConfiguration
        {
            Name = "测试模型", BaseUrl = "http://model.test", ModelIdentifier = "stub",
            AuthType = "None", SupportsTools = true, IsEnabled = true, IsDefault = true
        };
        db.ModelConfigurations.Add(modelConfiguration);
        db.UserModelGrants.Add(new UserModelGrant { UserId = admin.Id, ModelId = modelConfiguration.Id });
        var conversation = new ChatConversation { UserId = admin.Id, ModelConfigurationId = modelConfiguration.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new OpenApplicationTool(db)], permissions);
        var executions = new ChatToolExecutionService(db, registry, permissions);
        var handler = new StubModelHandler("open_application", """{"applicationName":"abc"}""");
        var models = new ModelConfigurationService(db, DataProtectionProvider.Create("AigcHub.Tests"),
            Options.Create(new ChatOptions()));
        var orchestrator = new ChatOrchestrator(db, registry, executions,
            new ChatModelClient(new StubHttpClientFactory(handler), models));

        var response = await orchestrator.SendAsync(admin.Id, conversation.Id, "打开 ancc应用", modelConfiguration.Id, default);
        using var responseJson = JsonDocument.Parse(JsonSerializer.Serialize(response));

        Assert.Contains("与“ancc”不一致", responseJson.RootElement.GetProperty("message").GetProperty("Content").GetString());
        Assert.False(await db.ChatToolExecutions.AnyAsync());
    }

    [Fact]
    public async Task Missing_published_app_returns_actual_failure_in_assistant_message()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var modelConfiguration = new AiModelConfiguration
        {
            Name = "测试模型", BaseUrl = "http://model.test", ModelIdentifier = "stub",
            AuthType = "None", SupportsTools = true, IsEnabled = true, IsDefault = true
        };
        db.ModelConfigurations.Add(modelConfiguration);
        db.UserModelGrants.Add(new UserModelGrant { UserId = admin.Id, ModelId = modelConfiguration.Id });
        var conversation = new ChatConversation { UserId = admin.Id, ModelConfigurationId = modelConfiguration.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new OpenApplicationTool(db)], permissions);
        var executions = new ChatToolExecutionService(db, registry, permissions);
        var handler = new StubModelHandler("open_application", """{"applicationName":"ancc"}""");
        var models = new ModelConfigurationService(db, DataProtectionProvider.Create("AigcHub.Tests"),
            Options.Create(new ChatOptions()));
        var orchestrator = new ChatOrchestrator(db, registry, executions,
            new ChatModelClient(new StubHttpClientFactory(handler), models));

        var response = await orchestrator.SendAsync(admin.Id, conversation.Id, "打开 ancc应用", modelConfiguration.Id, default);
        using var responseJson = JsonDocument.Parse(JsonSerializer.Serialize(response));

        var assistantContent = responseJson.RootElement.GetProperty("message").GetProperty("Content").GetString();
        Assert.Contains("没有找到已上架的应用", assistantContent);
        Assert.DoesNotContain("已提交", assistantContent);
        Assert.Equal("Failed", responseJson.RootElement.GetProperty("toolExecution").GetProperty("Status").GetString());
        Assert.Equal(ChatToolExecutionStatus.Failed, (await db.ChatToolExecutions.SingleAsync()).Status);
        Assert.True(await db.OperationAudits.AnyAsync(x => !x.Succeeded));
    }

    [Fact]
    public async Task Confirming_failed_write_does_not_reply_that_operation_succeeded()
    {
        await using var db = CreateDb();
        await SeedData.InitializeAsync(db);
        var admin = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00028");
        var existingCategory = await db.Categories.FirstAsync();
        var conversation = new ChatConversation { UserId = admin.Id };
        db.ChatConversations.Add(conversation);
        await db.SaveChangesAsync();
        var permissions = new DatabasePermissionService(db);
        var registry = new ChatToolRegistry([new CreateCategoryTool(db)], permissions);
        var executions = new ChatToolExecutionService(db, registry, permissions);
        await executions.ProposeAsync(admin.Id, conversation.Id, "create_category",
            JsonSerializer.SerializeToElement(new { name = existingCategory.Name }), default);
        var models = new ModelConfigurationService(db, DataProtectionProvider.Create("AigcHub.Tests"),
            Options.Create(new ChatOptions()));
        var orchestrator = new ChatOrchestrator(db, registry, executions,
            new ChatModelClient(new StubHttpClientFactory(new StubModelHandler()), models));

        var response = await orchestrator.SendAsync(admin.Id, conversation.Id, "确认", null, default);
        using var responseJson = JsonDocument.Parse(JsonSerializer.Serialize(response));

        Assert.Contains("分类名称已存在", responseJson.RootElement.GetProperty("message").GetProperty("Content").GetString());
        Assert.Equal("Failed", responseJson.RootElement.GetProperty("toolExecution").GetProperty("Status").GetString());
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class StubModelHandler(string toolName = "create_category", string arguments = """{"name":"demo3"}""") : HttpMessageHandler
    {
        public List<string> ToolNames { get; } = [];
        public List<string> MessageContents { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            ToolNames.AddRange(payload.RootElement.GetProperty("tools").EnumerateArray()
                .Select(item => item.GetProperty("function").GetProperty("name").GetString()!));
            MessageContents.AddRange(payload.RootElement.GetProperty("messages").EnumerateArray()
                .Select(item => item.GetProperty("content").GetString()!));
            // 测试可让模型故意返回错误工具或错误参数，验证服务端不会盲目执行。
            var reply = JsonSerializer.Serialize(new
            {
                choices = new[] { new { message = new { tool_calls = new[]
                {
                    new { function = new { name = toolName, arguments } }
                } } } }
            });
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(reply, Encoding.UTF8, "application/json")
            };
        }
    }

    private static AigcHubDbContext CreateDb()
    {
        var options = new DbContextOptionsBuilder<AigcHubDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
        return new AigcHubDbContext(options);
    }
}
