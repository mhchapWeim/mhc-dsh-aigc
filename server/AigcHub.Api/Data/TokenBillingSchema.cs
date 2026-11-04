using Microsoft.EntityFrameworkCore;
namespace AigcHub.Api.Data;
public static class TokenBillingSchema
{
    public static Task ApplyAsync(AigcHubDbContext db,CancellationToken ct)=>db.Database.IsRelational()?db.Database.ExecuteSqlRawAsync("""
    CREATE TABLE IF NOT EXISTS aigc_hub."TokenIncrementPackages" (
      "Id" uuid PRIMARY KEY,"UserId" uuid NOT NULL,"UserName" text NOT NULL,"EmployeeNo" text NOT NULL,
      "Tokens" bigint NOT NULL,"WeekStart" timestamptz NOT NULL,"ExpiresAt" timestamptz NOT NULL,
      "CreatedAt" timestamptz NOT NULL,"CreatedBy" uuid NULL,"Reason" text NOT NULL);
    CREATE INDEX IF NOT EXISTS "IX_TokenIncrementPackages_UserId_WeekStart" ON aigc_hub."TokenIncrementPackages" ("UserId","WeekStart");
    CREATE TABLE IF NOT EXISTS aigc_hub."TokenIncrementPackages" (
      "Id" uuid PRIMARY KEY,"UserId" uuid NOT NULL,"UserName" text NOT NULL,"EmployeeNo" text NOT NULL,
      "Tokens" bigint NOT NULL,"WeekStart" timestamptz NOT NULL,"ExpiresAt" timestamptz NOT NULL,
      "CreatedAt" timestamptz NOT NULL,"CreatedBy" uuid NULL,"Reason" text NOT NULL);
    CREATE INDEX IF NOT EXISTS "IX_TokenIncrementPackages_UserId_WeekStart" ON aigc_hub."TokenIncrementPackages" ("UserId","WeekStart");
    CREATE TABLE IF NOT EXISTS aigc_hub."TokenBillingPlans" (
      "Id" uuid PRIMARY KEY,"Name" text NOT NULL,"WeeklyTokens" bigint NOT NULL,"IsEnabled" boolean NOT NULL);
    ALTER TABLE aigc_hub."TokenBillingPlans" ADD COLUMN IF NOT EXISTS "DeletedAt" timestamptz NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "IX_TokenBillingPlans_Name" ON aigc_hub."TokenBillingPlans" ("Name");
    CREATE TABLE IF NOT EXISTS aigc_hub."TokenBillingAssignments" (
      "SubjectType" text NOT NULL,"SubjectId" uuid NOT NULL,"PlanId" uuid NOT NULL,
      PRIMARY KEY ("SubjectType","SubjectId"));
    CREATE TABLE IF NOT EXISTS aigc_hub."TokenBillingEntries" (
      "Id" uuid PRIMARY KEY,"UserId" uuid NOT NULL,"DepartmentId" uuid NULL,"EmployeeNo" text NOT NULL,
      "UserName" text NOT NULL,"DepartmentName" text NOT NULL,"PlanId" uuid NOT NULL,"ModelId" uuid NOT NULL,
      "ModelName" text NOT NULL,"ModelIdentifier" text NOT NULL,"WeekStart" timestamptz NOT NULL,"CreatedAt" timestamptz NOT NULL,
      "Multiplier" numeric NOT NULL,"ReservedTokens" bigint NOT NULL,"InputTokens" bigint NOT NULL,"OutputTokens" bigint NOT NULL,
      "TotalTokens" bigint NOT NULL,"ChargedTokens" bigint NOT NULL,"Status" text NOT NULL,"Note" text NOT NULL);
    CREATE INDEX IF NOT EXISTS "IX_TokenBillingEntries_UserId_WeekStart" ON aigc_hub."TokenBillingEntries" ("UserId","WeekStart");
    CREATE INDEX IF NOT EXISTS "IX_TokenBillingEntries_CreatedAt" ON aigc_hub."TokenBillingEntries" ("CreatedAt");
    """,ct):Task.CompletedTask;
}
