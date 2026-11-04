using Microsoft.EntityFrameworkCore;
namespace AigcHub.Api.Data;

public static class UserSyncSchema
{
    public static Task ApplyAsync(AigcHubDbContext db, CancellationToken ct) => db.Database.IsRelational() ? db.Database.ExecuteSqlRawAsync("""
        ALTER TABLE aigc_hub."Users" ADD COLUMN IF NOT EXISTS "SyncVersion" bigint NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS aigc_hub."UserSyncBatches" (
          "Id" uuid PRIMARY KEY, "CreatedBy" uuid NOT NULL, "CreatedAt" timestamptz NOT NULL, "Total" integer NOT NULL);
        CREATE TABLE IF NOT EXISTS aigc_hub."UserSyncMessages" (
          "Id" uuid PRIMARY KEY, "UserId" uuid NOT NULL, "UserName" text NOT NULL, "EmployeeNo" text NOT NULL,
          "UserVersion" bigint NOT NULL, "BatchId" uuid NULL, "EventType" text NOT NULL, "Payload" text NOT NULL,
          "Status" text NOT NULL, "Attempts" integer NOT NULL, "ConsecutiveFailures" integer NOT NULL, "CreatedAt" timestamptz NOT NULL,
          "NextAttemptAt" timestamptz NOT NULL, "SentAt" timestamptz NULL, "LastError" text NOT NULL);
        CREATE INDEX IF NOT EXISTS "IX_UserSyncMessages_Status_NextAttemptAt" ON aigc_hub."UserSyncMessages" ("Status", "NextAttemptAt");
        CREATE INDEX IF NOT EXISTS "IX_UserSyncMessages_UserId_CreatedAt" ON aigc_hub."UserSyncMessages" ("UserId", "CreatedAt");
        CREATE INDEX IF NOT EXISTS "IX_UserSyncMessages_BatchId" ON aigc_hub."UserSyncMessages" ("BatchId");
        """, ct) : Task.CompletedTask;
}
