using System.Net;
using System.Text;
using AigcHub.Api.Data;
using AigcHub.Api.Domain;
using AigcHub.Api.Services;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AigcHub.Tests;

public class VirtualKeyModelAccessTests
{
    [Fact]
    public async Task Assigned_key_models_work_without_user_model_grants_and_restrict_resolution()
    {
        await using var f = await Fixture.Create();
        Assert.Equal(f.Alpha.Id, Assert.Single(await f.Models.AvailableAsync(f.User.Id, default)).Id);
        Assert.Equal(f.Alpha.Id, (await f.Models.ResolveGrantedAsync(f.User.Id, f.Alpha.Id, default))!.Id);
        Assert.Equal("Bearer sk-alpha", f.Handler.Authorization);
        Assert.Equal("http://gateway.test/v1/models", f.Handler.Uri);
        var denied = await Assert.ThrowsAsync<WorkflowException>(() => f.Models.ResolveGrantedAsync(f.User.Id, f.Beta.Id, default));
        Assert.Equal(403, denied.StatusCode);
    }

    [Fact]
    public async Task Legacy_direct_and_role_grants_cannot_expand_assigned_key_scope()
    {
        await using var f = await Fixture.Create();
        f.Db.UserModelGrants.Add(new UserModelGrant { UserId=f.User.Id, ModelId=f.Beta.Id });
        f.Db.AccessGrants.Add(new AccessGrant { ResourceKey=AccessGrantService.ModelKey(f.Beta.Id), SubjectType="User", SubjectId=f.User.Id });
        await f.Db.SaveChangesAsync();
        Assert.Equal(f.Alpha.Id, Assert.Single(await f.Models.AvailableAsync(f.User.Id, default)).Id);
        f.Handler.Json="""{"data":[]}""";
        Assert.Empty(await f.Models.AvailableAsync(f.User.Id, default));
        Assert.Null(await f.Models.ResolveGrantedAsync(f.User.Id, null, default));
        await Assert.ThrowsAsync<WorkflowException>(()=>f.Models.ResolveGrantedAsync(f.User.Id,f.Beta.Id,default));
    }

    [Fact]
    public async Task Key_change_and_policy_change_take_effect_without_copying_model_grants()
    {
        await using var f = await Fixture.Create();
        var protection=f.Protection.CreateProtector("AigcHub.ManagedVirtualKey.v1");
        var second=new ManagedVirtualKey { Alias="beta",KeyProtected=protection.Protect("sk-beta") };
        f.Db.ManagedVirtualKeys.Add(second);
        f.Db.AccessGrants.Remove(await f.Db.AccessGrants.SingleAsync());
        f.Db.AccessGrants.Add(new AccessGrant { ResourceKey=$"virtual-key:{second.Id:D}",SubjectType="User",SubjectId=f.User.Id });
        await f.Db.SaveChangesAsync();
        f.Handler.Json="""{"data":[{"id":"beta"}]}""";
        Assert.Equal(f.Beta.Id,Assert.Single(await f.Models.AvailableAsync(f.User.Id,default)).Id);
        Assert.Equal("Bearer sk-beta",f.Handler.Authorization);
        Assert.Empty(await f.Db.UserModelGrants.ToArrayAsync());
        second.IsEnabled=false;
        await f.Db.SaveChangesAsync();
        Assert.Empty(await f.Models.AvailableAsync(f.User.Id,default));
    }

    [Fact]
    public async Task Inherited_key_membership_also_exposes_models()
    {
        await using var f=await Fixture.Create();
        var department=new Department {Code="dev",Name="开发部"};
        f.Db.Departments.Add(department); f.User.DepartmentId=department.Id;
        var grant=await f.Db.AccessGrants.SingleAsync();
        f.Db.AccessGrants.Remove(grant);
        f.Db.AccessGrants.Add(new AccessGrant { ResourceKey=grant.ResourceKey,SubjectType="Department",SubjectId=department.Id });
        await f.Db.SaveChangesAsync();
        Assert.Equal(f.Alpha.Id,Assert.Single(await f.Models.AvailableAsync(f.User.Id,default)).Id);
        f.User.IsEnabled=false;await f.Db.SaveChangesAsync();
        Assert.Empty(await f.Models.AvailableAsync(f.User.Id,default));
    }

    [Theory]
    [InlineData("{}",200)]
    [InlineData("{\"data\":[{}]}",200)]
    [InlineData("{\"data\":[]}",403)]
    public async Task Invalid_or_rejected_catalog_never_falls_back_to_old_grants(string body,int status)
    {
        await using var f=await Fixture.Create();
        f.Db.UserModelGrants.Add(new UserModelGrant { UserId=f.User.Id,ModelId=f.Beta.Id });await f.Db.SaveChangesAsync();
        f.Handler.Json=body;f.Handler.Status=(HttpStatusCode)status;
        await Assert.ThrowsAsync<WorkflowException>(()=>f.Models.AvailableAsync(f.User.Id,default));
    }

    private sealed class Fixture : IAsyncDisposable
    {
        public AigcHubDbContext Db=null!;
        public AppUser User=null!;
        public AiModelConfiguration Alpha=null!,Beta=null!;
        public ModelConfigurationService Models=null!;
        public EphemeralDataProtectionProvider Protection=new();
        public Handler Handler=new();
        public static async Task<Fixture> Create()
        {
            var f=new Fixture();
            f.Db=new(new DbContextOptionsBuilder<AigcHubDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
            f.User=new() { EmployeeNo="test",Name="测试",Email="test@example.test",PasswordHash="unused" };
            f.Alpha=new() { Name="Alpha",ProviderKind="LiteLLM",ModelIdentifier="alpha",BaseUrl="http://gateway.test/v1",AuthType="None",IsEnabled=true };
            f.Beta=new() { Name="Beta",ProviderKind="LiteLLM",ModelIdentifier="beta",BaseUrl="http://gateway.test/v1",AuthType="None",IsEnabled=true };
            var key=new ManagedVirtualKey { Alias="alpha",KeyProtected=f.Protection.CreateProtector("AigcHub.ManagedVirtualKey.v1").Protect("sk-alpha") };
            f.Db.AddRange(f.User,f.Alpha,f.Beta,key,new AccessGrant { ResourceKey=$"virtual-key:{key.Id:D}",SubjectType="User",SubjectId=f.User.Id });
            await f.Db.SaveChangesAsync();
            var service=new LiteLlmVirtualKeyService(new Factory(f.Handler),Options.Create(new LiteLlmOptions {BaseUrl="http://gateway.test/v1",PublicBaseUrl="http://gateway.test/v1"}),f.Db,f.Protection,NullLogger<LiteLlmVirtualKeyService>.Instance);
            f.Models=new(f.Db,new AccessGrantService(f.Db),f.Protection,Options.Create(new ChatOptions()),service);
            return f;
        }
        public ValueTask DisposeAsync()=>Db.DisposeAsync();
    }
    private sealed class Factory(Handler handler):IHttpClientFactory
    {public HttpClient CreateClient(string name)=>new(handler,disposeHandler:false);}
    private sealed class Handler:HttpMessageHandler
    {
        public string Json="""{"data":[{"id":"alpha"}]}""";
        public HttpStatusCode Status=HttpStatusCode.OK;
        public string? Authorization,Uri;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct)
        {
            Authorization=request.Headers.Authorization?.ToString();Uri=request.RequestUri?.ToString();
            return Task.FromResult(new HttpResponseMessage(Status){Content=new StringContent(Json,Encoding.UTF8,"application/json")});
        }
    }
}
