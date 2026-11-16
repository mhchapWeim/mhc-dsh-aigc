using AigcHub.Api.Domain;
using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Data;

public sealed partial class AigcHubDbContext
{
    public DbSet<IntegrationService> IntegrationServices => Set<IntegrationService>();
    public DbSet<IntegrationInvocation> IntegrationInvocations => Set<IntegrationInvocation>();
    public DbSet<IntegrationReceipt> IntegrationReceipts => Set<IntegrationReceipt>();
    public DbSet<GiteaConnection> GiteaConnections => Set<GiteaConnection>();
    public DbSet<GiteaAuthorization> GiteaAuthorizations => Set<GiteaAuthorization>();

    private static void ConfigureIntegrations(ModelBuilder b)
    {
        b.Entity<IntegrationService>().HasIndex(x => x.Code).IsUnique();
        b.Entity<IntegrationInvocation>().HasIndex(x => new { x.Status, x.NextAttemptAt });
        b.Entity<IntegrationInvocation>().Property(x => x.ConcurrencyToken).IsConcurrencyToken();
        b.Entity<IntegrationReceipt>().HasIndex(x => new { x.ServiceCode, x.MessageId }).IsUnique();
        b.Entity<GiteaConnection>().HasIndex(x => new { x.UserId, x.ServiceCode }).IsUnique();
        b.Entity<GiteaConnection>().HasIndex(x => new { x.ServiceCode, x.ExternalUserId }).IsUnique();
        b.Entity<GiteaAuthorization>().Property(x => x.Consumed).IsConcurrencyToken();
    }
}
