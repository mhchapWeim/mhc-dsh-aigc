using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AigcHub.Tests;

public sealed class AccessReviewAssignmentHttpTests
{
    [Fact]
    public async Task One_access_flow_assigns_each_application_to_its_own_reviewer()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var applicant = await Login(factory, "wh00412");
        var ownerA = await AddUser(factory, "wh00901", "负责人甲", "normal-user");
        var ownerB = await AddUser(factory, "wh00902", "负责人乙", "normal-user");
        await PublishAccessProcess(admin, "appOwner", "workflow-admin");
        var registered = await CreateRegistered(admin, "注册甲", ownerA);
        var published = await CreatePublished(factory, admin, "发布乙", ownerB);

        var first = await applicant.PostAsJsonAsync($"/api/catalog/registered-apps/{registered}/access-request", new { reason = "需要注册应用" });
        var second = await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = published, reason = "需要发布应用" });
        first.EnsureSuccessStatusCode();
        second.EnsureSuccessStatusCode();

        var registeredTask = await TaskFor(factory, registeredApplicationId: registered);
        var publishedTask = await TaskFor(factory, publicationId: published);
        Assert.Equal(["owner"], Sources(registeredTask));
        Assert.Equal([ownerA.ToString()], Users(registeredTask));
        Assert.Equal(["owner"], Sources(publishedTask));
        Assert.Equal([ownerB.ToString()], Users(publishedTask));
        Assert.Contains("分配给应用负责人", await History(factory, registeredTask.InstanceId));
    }

    [Fact]
    public async Task Missing_disabled_or_self_reviewer_uses_the_fallback_and_an_empty_role_leaves_nothing()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var applicant = await Login(factory, "wh00412");
        var applicantId = await UserId(factory, "wh00412");
        var fallbackId = await UserId(factory, "wh00136");
        var disabled = await AddUser(factory, "wh00903", "已停用负责人", "normal-user", enabled: false);
        await PublishAccessProcess(admin, "appOwner", "workflow-admin");

        var missing = await CreatePublished(factory, admin, "未指定", null);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = missing, reason = "没有负责人" })).EnsureSuccessStatusCode();
        var missingTask = await TaskFor(factory, publicationId: missing);
        Assert.Equal(["fallback"], Sources(missingTask));
        Assert.Equal([fallbackId.ToString()], Users(missingTask));
        Assert.Contains("转交兜底审核角色", await History(factory, missingTask.InstanceId));

        var stopped = await CreatePublished(factory, admin, "已停用", disabled);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = stopped, reason = "负责人停用" })).EnsureSuccessStatusCode();
        Assert.Equal([fallbackId.ToString()], Users(await TaskFor(factory, publicationId: stopped)));

        var self = await CreatePublished(factory, admin, "本人", applicantId);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = self, reason = "申请人就是负责人" })).EnsureSuccessStatusCode();
        var selfTask = await TaskFor(factory, publicationId: self);
        Assert.Equal(["fallback"], Sources(selfTask));
        Assert.DoesNotContain(applicantId.ToString(), Users(selfTask));
        var selfReview = await applicant.PostAsJsonAsync($"/api/workflow/tasks/{selfTask.Id}/complete", new { action = "approve", comment = "自己审" });
        Assert.Equal(HttpStatusCode.Forbidden, selfReview.StatusCode);
        Assert.Contains("不能审核自己", (await selfReview.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("detail").GetString());

        await AddRole(factory, "empty-reviewers", "空审核组");
        await PublishAccessProcess(admin, "appOwner", "empty-reviewers", key: "application-access-empty");
        var empty = await CreatePublished(factory, admin, "无人兜底", null);
        var before = await CountRequests(factory);
        var rejected = await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = empty, reason = "兜底没人" });
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Assert.Contains("没有可用成员", (await rejected.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("detail").GetString());
        Assert.Equal(before, await CountRequests(factory));
        Assert.Equal(0, await CountTasks(factory, empty));
    }

    [Fact]
    public async Task Ordinary_owner_handles_only_the_assigned_request_and_approval_still_grants_access()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var applicant = await Login(factory, "wh00412");
        var ownerId = await AddUser(factory, "wh00904", "普通负责人", "normal-user");
        var otherId = await UserId(factory, "wh00136");
        await PublishAccessProcess(admin, "appOwner", "workflow-admin");
        var ownApp = await CreateRegistered(admin, "自己的应用", ownerId);
        var otherApp = await CreateRegistered(admin, "别人的应用", otherId);
        (await applicant.PostAsJsonAsync($"/api/catalog/registered-apps/{ownApp}/access-request", new { reason = "请负责人处理" })).EnsureSuccessStatusCode();
        (await applicant.PostAsJsonAsync($"/api/catalog/registered-apps/{otherApp}/access-request", new { reason = "请别人处理" })).EnsureSuccessStatusCode();
        var ownTask = await TaskFor(factory, registeredApplicationId: ownApp);
        var otherTask = await TaskFor(factory, registeredApplicationId: otherApp);

        using var owner = await Login(factory, "wh00904");
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.GetAsync("/api/publication-requests/reviewable?page=1&pageSize=20")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.GetAsync("/api/workflow/tasks/mine")).StatusCode);
        var visible = await owner.GetFromJsonAsync<JsonElement>("/api/access-requests/reviewable");
        Assert.Single(visible.EnumerateArray());
        Assert.Equal("应用负责人", visible[0].GetProperty("assignment").GetString());
        var ownRequestId = visible[0].GetProperty("id").GetGuid();
        (await owner.GetAsync($"/api/access-requests/{ownRequestId}")).EnsureSuccessStatusCode();
        var otherRequest = await RequestId(factory, registeredApplicationId: otherApp);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.GetAsync($"/api/access-requests/{otherRequest}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.PostAsJsonAsync($"/api/workflow/tasks/{otherTask.Id}/complete", new { action = "approve", comment = "越权" })).StatusCode);

        var approved = await owner.PostAsJsonAsync($"/api/workflow/tasks/{ownTask.Id}/complete", new { action = "approve", comment = "同意访问" });
        approved.EnsureSuccessStatusCode();
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.True(await db.ApplicationPersonalGrants.AnyAsync(x => x.RegisteredApplicationId == ownApp && x.RevokedAt == null));
        Assert.Equal(WorkflowTaskStatus.Completed, (await db.WorkflowTasks.SingleAsync(x => x.Id == ownTask.Id)).Status);
    }

    [Fact]
    public async Task Changing_the_reviewer_affects_only_new_tasks_and_older_assignment_modes_keep_running()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var applicant = await Login(factory, "wh00412");
        var firstOwner = await AddUser(factory, "wh00905", "原负责人", "normal-user");
        var nextOwner = await AddUser(factory, "wh00906", "新负责人", "normal-user");
        var fixedUser = await UserId(factory, "wh00136");

        var publication = await SaveProcess(admin, "publication-owner", "publication", "appOwner", "workflow-admin", publish: true);
        Assert.Equal(HttpStatusCode.BadRequest, publication.StatusCode);
        Assert.Contains("只能用于访问申请", (await publication.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("message").GetString());
        var missingRole = await SaveProcess(admin, "application-access", "access", "appOwner", "", publish: true);
        Assert.Equal(HttpStatusCode.BadRequest, missingRole.StatusCode);

        var draft = await SaveProcess(admin, "application-access", "access", "appOwner", "workflow-admin", publish: false);
        draft.EnsureSuccessStatusCode();
        var draftId = (await draft.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var reopened = (await admin.GetFromJsonAsync<JsonElement>("/api/process-definitions")).EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == draftId);
        Assert.Contains("appOwner", reopened.GetProperty("definitionJson").GetString());
        Assert.Contains("workflow-admin", reopened.GetProperty("definitionJson").GetString());
        (await admin.PostAsync($"/api/process-definitions/{draftId}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = "application-access" })).EnsureSuccessStatusCode();

        var app = await CreatePublished(factory, admin, "会换负责人", firstOwner);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = app, reason = "第一张" })).EnsureSuccessStatusCode();
        var original = await TaskFor(factory, publicationId: app);
        Assert.Equal([firstOwner.ToString()], Users(original));

        (await admin.PutAsJsonAsync($"/api/application-registry/published/{app}/access-reviewer", new { userId = nextOwner })).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync($"/api/application-registry/published/{app}/access-reviewer", new { userId = (Guid?)null })).EnsureSuccessStatusCode();
        var cleared = await PublishedReviewer(factory, app);
        Assert.Null(cleared);
        (await admin.PutAsJsonAsync($"/api/application-registry/published/{app}/access-reviewer", new { userId = nextOwner })).EnsureSuccessStatusCode();
        var secondApplicant = await AddUser(factory, "wh00907", "另一申请人", "normal-user");
        using var another = await Login(factory, "wh00907");
        (await another.PostAsJsonAsync("/api/access-requests", new { applicationId = app, reason = "第二张" })).EnsureSuccessStatusCode();
        var created = await TasksFor(factory, app);
        Assert.Equal(2, created.Count);
        Assert.Equal([firstOwner.ToString()], Users(created.Single(x => x.Id == original.Id)));
        Assert.Equal([nextOwner.ToString()], Users(created.Single(x => x.Id != original.Id)));
        Assert.NotEqual(secondApplicant, nextOwner);

        await PublishFixed(admin, "users", fixedUser);
        var fixedApp = await CreatePublished(factory, admin, "固定人员", null);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = fixedApp, reason = "固定人员" })).EnsureSuccessStatusCode();
        var fixedTask = await TaskFor(factory, publicationId: fixedApp);
        Assert.Equal([fixedUser.ToString()], Users(fixedTask));
        Assert.Empty(Sources(fixedTask));

        var department = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key = "application-access-department", name = "部门审核", version = 0, isPublished = false, requestType = "access",
            definition = JsonDocument.Parse("""
                {"name":"部门审核","nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"部门审核","assignmentType":"department","assignee":"quality"},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end"}]}
                """).RootElement
        });
        department.EnsureSuccessStatusCode();
        var departmentId = (await department.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{departmentId}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = "application-access-department" })).EnsureSuccessStatusCode();
        var departmentApp = await CreatePublished(factory, admin, "部门应用", null);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = departmentApp, reason = "部门" })).EnsureSuccessStatusCode();
        var departmentTask = await TaskFor(factory, publicationId: departmentApp);
        Assert.Equal(["quality"], departmentTask.Candidates.Where(x => x.Type == "department").Select(x => x.Value).ToArray());
        Assert.Equal([firstOwner.ToString()], Users(created.Single(x => x.Id == original.Id)));
    }

    [Fact]
    public async Task Later_node_failure_rolls_back_the_current_approval()
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var reviewer = await Login(factory, "wh00136");
        using var applicant = await Login(factory, "wh00412");
        await AddRole(factory, "empty-reviewers", "空审核组");
        var created = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key = "application-access-two", name = "两级访问审核", version = 0, isPublished = false, requestType = "access",
            definition = JsonDocument.Parse("""
                {"name":"两级访问审核","nodes":[
                  {"id":"start","type":"start","name":"开始"},
                  {"id":"first","type":"userTask","name":"初审","assignmentType":"role","assignee":"workflow-admin"},
                  {"id":"second","type":"userTask","name":"终审","assignmentType":"appOwner","fallbackRole":"empty-reviewers"},
                  {"id":"end","type":"end","name":"结束"}
                ],"edges":[{"source":"start","target":"first"},{"source":"first","target":"second"},{"source":"second","target":"end"}]}
                """).RootElement
        });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{id}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = "application-access-two" })).EnsureSuccessStatusCode();
        var app = await CreatePublished(factory, admin, "两级", null);
        (await applicant.PostAsJsonAsync("/api/access-requests", new { applicationId = app, reason = "两级" })).EnsureSuccessStatusCode();
        var task = await TaskFor(factory, publicationId: app);
        var failed = await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{task.Id}/complete", new { action = "approve", comment = "通过但下一节点没人" });
        Assert.Equal(HttpStatusCode.Conflict, failed.StatusCode);
        Assert.Contains("没有可用成员", (await failed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("detail").GetString());
        var again = await TaskFor(factory, publicationId: app);
        Assert.Equal(WorkflowTaskStatus.Pending, again.Status);
        Assert.Equal(task.Id, again.Id);
        Assert.Equal(AccessRequestStatus.Reviewing, await RequestStatus(factory, app));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Approval_follows_the_end_edge_instead_of_creating_the_return_task(bool explicitConditions)
    {
        using var factory = new Factory();
        using var admin = await Login(factory, "wh00028");
        using var reviewer = await Login(factory, "wh00136");
        using var applicant = await Login(factory, "wh00412");
        const string key = "application-access-branch";
        var passed = explicitConditions ? ",\"outcome\":\"passed\"" : "";
        var rejected = explicitConditions ? ",\"outcome\":\"rejected\"" : "";
        using var definition = JsonDocument.Parse($$"""
            {"nodes":[
              {"id":"start","type":"start","name":"开始"},
              {"id":"review","type":"userTask","name":"初审","candidates":["role:workflow-admin"]},
              {"id":"return","type":"userTask","name":"退回申请人","assignmentType":"initiator"},
              {"id":"end","type":"end","name":"结束"}
            ],"edges":[
              {"source":"start","target":"review"},
              {"source":"review","target":"end","label":"审核通过"{{passed}}},
              {"source":"review","target":"return","label":"审核不通过"{{rejected}}},
              {"source":"return","target":"end"}
            ]}
            """);
        var created = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key, name = "访问申请审批分支", version = 0, isPublished = false, requestType = "access",
            definition = definition.RootElement
        });
        created.EnsureSuccessStatusCode();
        var definitionId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{definitionId}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = key })).EnsureSuccessStatusCode();
        var app = await CreateRegistered(admin, "访问审批分支", null);
        var submitted = await applicant.PostAsJsonAsync($"/api/catalog/registered-apps/{app}/access-request", new { reason = "需要访问" });
        submitted.EnsureSuccessStatusCode();
        var requestId = (await submitted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var task = await TaskFor(factory, registeredApplicationId: app);
        var completed = await reviewer.PostAsJsonAsync($"/api/workflow/tasks/{task.Id}/complete", new { action = "approve", comment = "通过" });
        completed.EnsureSuccessStatusCode();

        var mine = await applicant.GetFromJsonAsync<JsonElement>("/api/access-requests/mine");
        var request = Assert.Single(mine.EnumerateArray(), row => row.GetProperty("id").GetGuid() == requestId);
        Assert.Equal("Approved", request.GetProperty("status").GetString());
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        Assert.False(await db.WorkflowTasks.AnyAsync(x => x.InstanceId == task.InstanceId && x.NodeKey == "return"));
        Assert.True(await db.ApplicationPersonalGrants.AnyAsync(x => x.AccessRequestId == requestId && x.RevokedAt == null));
    }

    private static async Task<HttpResponseMessage> SaveProcess(HttpClient admin, string key, string requestType, string assignmentType, string fallbackRole, bool publish)
    {
        var roleField = string.IsNullOrEmpty(fallbackRole) ? "" : $",\"fallbackRole\":\"{fallbackRole}\"";
        var definition = JsonDocument.Parse($$"""
            {"name":"{{key}}","nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"访问审核","assignmentType":"{{assignmentType}}"{{roleField}}},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end"}]}
            """).RootElement;
        return await admin.PostAsJsonAsync("/api/process-definitions", new { key, name = key, version = 0, isPublished = publish, requestType, definition });
    }

    private static async Task PublishAccessProcess(HttpClient admin, string assignmentType, string fallbackRole, string key = "application-access")
    {
        var created = await SaveProcess(admin, key, "access", assignmentType, fallbackRole, false);
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{id}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = key })).EnsureSuccessStatusCode();
    }

    private static async Task PublishFixed(HttpClient admin, string assignmentType, Guid userId)
    {
        var created = await admin.PostAsJsonAsync("/api/process-definitions", new
        {
            key = "application-access-fixed", name = "固定处理人", version = 0, isPublished = false, requestType = "access",
            definition = JsonDocument.Parse($$"""
                {"name":"固定处理人","nodes":[{"id":"start","type":"start","name":"开始"},{"id":"review","type":"userTask","name":"指定审核","assignmentType":"{{assignmentType}}","assigneeIds":["{{userId}}"]},{"id":"end","type":"end","name":"结束"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end"}]}
                """).RootElement
        });
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        (await admin.PostAsync($"/api/process-definitions/{id}/publish", null)).EnsureSuccessStatusCode();
        (await admin.PutAsJsonAsync("/api/process-bindings/access", new { processKey = "application-access-fixed" })).EnsureSuccessStatusCode();
    }

    private static async Task<Guid> CreateRegistered(HttpClient admin, string name, Guid? reviewer)
    {
        var categoryId = (await admin.GetFromJsonAsync<JsonElement>("/api/application-registry/options")).GetProperty("categories").EnumerateArray().First().GetProperty("id").GetGuid();
        var created = await admin.PostAsJsonAsync("/api/application-registry", new
        {
            name, nameEn = name, description = "简介", descriptionEn = "Description", owner = "质量部", ownerEn = "Quality",
            categoryId, categoryEn = "", accessUrl = "https://origin.example/" + Guid.NewGuid().ToString("N") + "/",
            isEnabled = true, sortOrder = 0, accessMode = "Subjects", grants = Array.Empty<object>(), accessReviewerId = reviewer
        });
        created.EnsureSuccessStatusCode();
        return (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<Guid> CreatePublished(Factory factory, HttpClient admin, string name, Guid? reviewer)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var category = await db.Categories.FirstAsync();
        var applicant = await db.Users.SingleAsync(x => x.EmployeeNo == "wh00412");
        var app = new PublicationRequest
        {
            RequestNo = "PUB-" + Guid.NewGuid().ToString("N")[..8], AppName = name, Summary = "已发布",
            CategoryId = category.Id, ApplicantId = applicant.Id, Status = PublicationStatus.Approved,
            AccessMode = "Subjects", Version = "1.0.0", OperationalEnabled = true, AccessReviewerId = reviewer
        };
        db.PublicationRequests.Add(app);
        db.ApplicationRoutes.Add(new ApplicationRoute
        {
            PublicationRequestId = app.Id, Slug = "app-" + Guid.NewGuid().ToString("N")[..10],
            UpstreamUrl = "https://origin.example/app/", Status = "Ready"
        });
        await db.SaveChangesAsync();
        var listed = await admin.GetFromJsonAsync<JsonElement>("/api/application-registry/published");
        var row = listed.EnumerateArray().Single(x => x.GetProperty("id").GetGuid() == app.Id);
        if (reviewer is Guid userId) Assert.Equal(userId, row.GetProperty("accessReviewerId").GetGuid());
        else Assert.Equal(JsonValueKind.Null, row.GetProperty("accessReviewerId").ValueKind);
        return app.Id;
    }

    private static async Task<Guid> AddUser(Factory factory, string employeeNo, string name, string roleCode, bool enabled = true)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var hash = (await db.Users.AsNoTracking().FirstAsync()).PasswordHash;
        var role = await db.Roles.SingleAsync(x => x.Code == roleCode);
        var department = await db.Departments.FirstAsync();
        var user = new AppUser
        {
            EmployeeNo = employeeNo, Name = name, Email = employeeNo + "@bhss.com", PasswordHash = hash,
            IsEnabled = enabled, DepartmentId = department.Id
        };
        db.Users.Add(user);
        db.UserRoles.Add(new UserRole { User = user, Role = role });
        await db.SaveChangesAsync();
        return user.Id;
    }

    private static async Task AddRole(Factory factory, string code, string name)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        db.Roles.Add(new Role { Code = code, Name = name });
        await db.SaveChangesAsync();
    }

    private static async Task<Guid> UserId(Factory factory, string employeeNo)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        return (await db.Users.SingleAsync(x => x.EmployeeNo == employeeNo)).Id;
    }

    private static async Task<WorkflowTask> TaskFor(Factory factory, Guid? publicationId = null, Guid? registeredApplicationId = null)
    {
        var tasks = await TasksFor(factory, publicationId, registeredApplicationId);
        return Assert.Single(tasks);
    }

    private static async Task<List<WorkflowTask>> TasksFor(Factory factory, Guid? publicationId = null, Guid? registeredApplicationId = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var requestIds = await db.ApplicationAccessRequests.AsNoTracking()
            .Where(x => publicationId == null || x.PublicationRequestId == publicationId)
            .Where(x => registeredApplicationId == null || x.RegisteredApplicationId == registeredApplicationId)
            .Select(x => x.ProcessInstanceId).ToListAsync();
        return await db.WorkflowTasks.AsNoTracking().Include(x => x.Candidates)
            .Where(x => requestIds.Contains(x.InstanceId)).OrderBy(x => x.CreatedAt).ToListAsync();
    }

    private static async Task<Guid> RequestId(Factory factory, Guid? publicationId = null, Guid? registeredApplicationId = null)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        return await db.ApplicationAccessRequests.Where(x => x.RegisteredApplicationId == registeredApplicationId && x.PublicationRequestId == publicationId)
            .Select(x => x.Id).SingleAsync();
    }

    private static async Task<AccessRequestStatus> RequestStatus(Factory factory, Guid publicationId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        return await db.ApplicationAccessRequests.Where(x => x.PublicationRequestId == publicationId).Select(x => x.Status).SingleAsync();
    }

    private static async Task<int> CountRequests(Factory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        return await db.ApplicationAccessRequests.CountAsync();
    }

    private static async Task<int> CountTasks(Factory factory, Guid publicationId)
    {
        return (await TasksFor(factory, publicationId)).Count;
    }

    private static async Task<Guid?> PublishedReviewer(Factory factory, Guid id)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        return await db.PublicationRequests.Where(x => x.Id == id).Select(x => x.AccessReviewerId).SingleAsync();
    }

    private static async Task<string> History(Factory factory, Guid instanceId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AigcHubDbContext>();
        var details = await db.WorkflowHistory.Where(x => x.InstanceId == instanceId).Select(x => x.Detail).ToListAsync();
        return string.Join('\n', details);
    }

    private static string[] Users(WorkflowTask task) => task.Candidates.Where(x => x.Type == "user").Select(x => x.Value).Order().ToArray();
    private static string[] Sources(WorkflowTask task) => task.Candidates.Where(x => x.Type == "source").Select(x => x.Value).ToArray();

    private static async Task<HttpClient> Login(Factory factory, string employeeNo)
    {
        var client = factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/auth/login", new { employeeNo, password = "Bhss@123" });
        response.EnsureSuccessStatusCode();
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", session.GetProperty("accessToken").GetString());
        return client;
    }

    private sealed class Factory : WebApplicationFactory<Program>
    {
        private readonly string database = "access-review-" + Guid.NewGuid().ToString("N");
        protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.ConfigureServices(services =>
        {
            services.RemoveAll<DbContextOptions<AigcHubDbContext>>();
            services.RemoveAll<IDbContextOptionsConfiguration<AigcHubDbContext>>();
            services.AddDbContext<AigcHubDbContext>(options => options.UseInMemoryDatabase(database));
        });
    }
}
