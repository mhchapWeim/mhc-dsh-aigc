using System.Text.Json;
using AigcHub.Api.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Data;

public static class SeedData
{
    public static async Task InitializeAsync(AigcHubDbContext db, CancellationToken ct = default)
    {
        await db.Database.EnsureCreatedAsync(ct);
        await DatabaseSchemaInitializer.ApplyAdditiveChangesAsync(db, ct);
        if (await db.Users.AnyAsync(ct))
        {
            await EnsureModelPermissionAsync(db, ct);
            await EnsureDistributionPermissionsAsync(db, ct);
            await EnsurePublishingProcessV2Async(db, ct);
            return;
        }

        var departments = new[]
        {
            new Department { Code = "digital", Name = "数字化办公室", Description = "数字化平台与智能应用建设" },
            new Department { Code = "hr", Name = "人力资源部", Description = "组织与人才服务" },
            new Department { Code = "quality", Name = "质量管理部", Description = "质量体系与问题闭环" },
            new Department { Code = "rd", Name = "研发中心", Description = "产品与软件研发" },
            new Department { Code = "legal", Name = "法务部", Description = "合同与合规管理" }
        };
        var permissions = new[]
        {
            Permission("portal.view", "访问应用门户", "/"), Permission("admin.view", "访问管理后台", "/admin"),
            Permission("publication.create", "提交发布申请", "/admin/publications"), Permission("publication.review", "审核发布申请", "/admin/reviews"),
            Permission("process.design", "设计并发布流程", "/admin/processes"), Permission("user.manage", "用户管理", "/admin/users"),
            Permission("department.manage", "部门管理", "/admin/departments"), Permission("category.manage", "分类管理", "/admin/categories"),
            Permission("role.manage", "角色与权限管理", "/admin/roles"),
            Permission("model.manage", "模型接入管理", "/admin/models"),
            Permission("plugin.manage", "插件市场管理", "/admin/plugins"),
            Permission("announcement.manage", "客户端公告管理", "/admin/announcements"),
            Permission("client-release.manage", "客户端版本发布", "/admin/client-releases"),
            Permission("diagnostic.manage", "DSH 失败日志", "/admin/dsh-failures")
        };
        var adminRole = new Role { Code = "platform-admin", Name = "平台管理员", Description = "管理平台配置、用户与全部业务功能", IsBuiltIn = true };
        var workflowRole = new Role { Code = "workflow-admin", Name = "流程管理员", Description = "设计流程并处理应用发布审核", IsBuiltIn = true };
        var userRole = new Role { Code = "normal-user", Name = "普通用户", Description = "提交并跟踪自己的应用发布申请", IsBuiltIn = true };
        adminRole.Permissions = permissions.Select(x => new RolePermission { Role = adminRole, Permission = x }).ToList();
        workflowRole.Permissions = permissions.Where(x => new[] { "portal.view", "admin.view", "publication.create", "publication.review", "process.design" }.Contains(x.Code)).Select(x => new RolePermission { Role = workflowRole, Permission = x }).ToList();
        userRole.Permissions = permissions.Where(x => new[] { "portal.view", "admin.view", "publication.create" }.Contains(x.Code)).Select(x => new RolePermission { Role = userRole, Permission = x }).ToList();

        var hasher = new PasswordHasher<AppUser>();
        var admin = User("wh00028", "姚伟明", "di.Yao@boschhuayu-steering.com", departments[0]);
        var workflow = User("wh00136", "张敏", "min.zhang@bhss.com", departments[1]);
        var applicant = User("wh00412", "李俊", "jun.li@bhss.com", departments[2]);
        foreach (var user in new[] { admin, workflow, applicant }) user.PasswordHash = hasher.HashPassword(user, "Bhss@123");
        admin.Roles.Add(new UserRole { User = admin, Role = adminRole });
        workflow.Roles.Add(new UserRole { User = workflow, Role = workflowRole });
        applicant.Roles.Add(new UserRole { User = applicant, Role = userRole });

        var categories = new[]
        {
            new AppCategory { Code = "service", Name = "智慧服务", Description = "面向员工的人事、行政与共享服务", SortOrder = 1 },
            new AppCategory { Code = "knowledge", Name = "知识智能", Description = "企业知识检索、问答与风险识别", Color = "#7357d9", SortOrder = 2 },
            new AppCategory { Code = "office", Name = "效率办公", Description = "会议、协作与日常办公提效工具", Color = "#d56b1c", SortOrder = 3 },
            new AppCategory { Code = "research", Name = "研发创新", Description = "面向产品与软件研发的智能能力", Color = "#0f8f91", SortOrder = 4 }
        };
        var process = new ProcessDefinition
        {
            Key = "application-publishing", Name = "应用发布审批流程", Version = 2, IsPublished = true,
            DefinitionJson = PublishingProcessV2Json()
        };
        db.AddRange(departments); db.AddRange(permissions); db.AddRange(adminRole, workflowRole, userRole);
        db.AddRange(admin, workflow, applicant); db.AddRange(categories); db.Add(process);
        await db.SaveChangesAsync(ct);
    }

    private static Permission Permission(string code, string name, string page) => new() { Code = code, Name = name, PagePath = page };
    private static AppUser User(string no, string name, string email, Department department) => new() { EmployeeNo = no, Name = name, Email = email, Department = department, PasswordHash = "" };

    private static async Task EnsureDistributionPermissionsAsync(AigcHubDbContext db, CancellationToken ct)
    {
        var admin = await db.Roles.Include(x => x.Permissions).SingleOrDefaultAsync(x => x.Code == "platform-admin", ct);
        foreach (var (code, name, page) in new[] {
            ("announcement.manage", "客户端公告管理", "/admin/announcements"),
            ("client-release.manage", "客户端版本发布", "/admin/client-releases"),
            ("plugin.manage", "插件市场管理", "/admin/plugins"),
            ("diagnostic.manage", "DSH 失败日志", "/admin/dsh-failures") })
        {
            var permission = await db.Permissions.SingleOrDefaultAsync(x => x.Code == code, ct);
            if (permission is null) { permission = Permission(code, name, page); db.Permissions.Add(permission); }
            if (admin is not null && admin.Permissions.All(x => x.PermissionId != permission.Id))
                admin.Permissions.Add(new RolePermission { Role = admin, Permission = permission });
        }
        await db.SaveChangesAsync(ct);
    }

    private static async Task EnsureModelPermissionAsync(AigcHubDbContext db, CancellationToken ct)
    {
        var permission = await db.Permissions.SingleOrDefaultAsync(x => x.Code == "model.manage", ct);
        if (permission is null)
        {
            permission = Permission("model.manage", "模型接入管理", "/admin/models");
            db.Permissions.Add(permission);
        }
        var adminRole = await db.Roles.Include(x => x.Permissions).SingleOrDefaultAsync(x => x.Code == "platform-admin", ct);
        if (adminRole is not null && adminRole.Permissions.All(x => x.PermissionId != permission.Id))
            adminRole.Permissions.Add(new RolePermission { Role = adminRole, Permission = permission });
        await db.SaveChangesAsync(ct);
    }

    private static async Task EnsurePublishingProcessV2Async(AigcHubDbContext db, CancellationToken ct)
    {
        if (await db.ProcessDefinitions.AnyAsync(x => x.Key == "application-publishing" && x.Version >= 2, ct)) return;
        var oldDefinitions = await db.ProcessDefinitions.Where(x => x.Key == "application-publishing" && x.IsPublished).ToListAsync(ct);
        foreach (var definition in oldDefinitions) definition.IsPublished = false;
        db.ProcessDefinitions.Add(new ProcessDefinition
        {
            Key = "application-publishing", Name = "应用发布审批流程", Version = 2, IsPublished = true,
            DefinitionJson = PublishingProcessV2Json()
        });
        await db.SaveChangesAsync(ct);
    }

    private static string PublishingProcessV2Json() => JsonSerializer.Serialize(new
    {
        nodes = new object[]
        {
            new { id = "start", type = "start", name = "开始" },
            new { id = "code_review", type = "userTask", name = "仓库代码审核", candidates = new[] { "role:workflow-admin", "department:digital" } },
            new { id = "deploy_approval", type = "userTask", name = "部署审批", candidates = new[] { "role:platform-admin" } },
            new { id = "publish", type = "serviceTask", name = "等待部署回调", callback = "application-publish" },
            new { id = "end", type = "end", name = "发布完成" }
        }
    });
}
