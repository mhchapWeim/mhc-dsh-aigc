using AigcHub.Api.Configuration;
using AigcHub.Api.Data;
using AigcHub.Api.Endpoints;

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

public partial class Program;
