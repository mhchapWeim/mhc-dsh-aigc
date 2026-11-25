using AigcHub.Api.Configuration;
using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;

public partial class Program
{
    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.AddAigcHubServices();
        var app = builder.Build();
        app.UseAigcHubPipeline();
        app.MapAigcHubEndpoints();
        await using (var scope = app.Services.CreateAsyncScope())
        {
            await SeedData.InitializeAsync(scope.ServiceProvider.GetRequiredService<AigcHubDbContext>());
        }
        await app.RunAsync();
    }
}
