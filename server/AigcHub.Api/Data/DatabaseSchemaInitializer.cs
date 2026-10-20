using Microsoft.EntityFrameworkCore;

namespace AigcHub.Api.Data;

public static class DatabaseSchemaInitializer
{
    public static async Task ApplyAdditiveChangesAsync(AigcHubDbContext db, CancellationToken ct = default)
    {
        if (!db.Database.IsRelational()) return;
        const string sql = """
        CREATE TABLE IF NOT EXISTS aigc_hub."DshBackups" (
            "Id" uuid PRIMARY KEY, "UserId" uuid NOT NULL REFERENCES aigc_hub."Users" ("Id"),
            "Payload" text NOT NULL, "Sha256" text NOT NULL, "Bytes" bigint NOT NULL,
            "SessionCount" integer NOT NULL, "Scope" text NOT NULL, "CreatedAt" timestamp with time zone NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_DshBackups_UserId_CreatedAt" ON aigc_hub."DshBackups" ("UserId", "CreatedAt");
        CREATE TABLE IF NOT EXISTS aigc_hub."DshFeedbacks" (
            "Id" uuid PRIMARY KEY, "UserId" uuid NOT NULL REFERENCES aigc_hub."Users" ("Id"),
            "SessionId" text NOT NULL, "Category" text NOT NULL, "Text" text NOT NULL,
            "SessionLog" text NOT NULL, "CreatedAt" timestamp with time zone NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IX_DshFeedbacks_CreatedAt" ON aigc_hub."DshFeedbacks" ("CreatedAt");
        CREATE TABLE IF NOT EXISTS aigc_hub."ManagedPlugins" (
            "Id" uuid PRIMARY KEY, "PackageName" text NOT NULL, "Name" text NOT NULL, "Description" text NOT NULL,
            "IsEnabled" boolean NOT NULL, "PublishedVersionId" uuid NULL, "Revision" bigint NOT NULL,
            "ConfigurationJson" text NOT NULL, "ServerSecretProtected" text NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_ManagedPlugins_PackageName" ON aigc_hub."ManagedPlugins" ("PackageName");
        CREATE TABLE IF NOT EXISTS aigc_hub."ManagedPluginVersions" (
            "Id" uuid PRIMARY KEY, "PluginId" uuid NOT NULL REFERENCES aigc_hub."ManagedPlugins" ("Id"),
            "Version" text NOT NULL, "DshVersion" text NOT NULL, "Sha256" text NOT NULL, "Size" bigint NOT NULL,
            "ManifestJson" text NOT NULL, "CreatedAt" timestamp with time zone NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_ManagedPluginVersions_PluginId_Version" ON aigc_hub."ManagedPluginVersions" ("PluginId", "Version");
        CREATE TABLE IF NOT EXISTS aigc_hub."ManagedPluginReports" (
            "UserId" uuid NOT NULL, "DeviceId" text NOT NULL, "PluginId" uuid NOT NULL, "Version" text NOT NULL,
            "Revision" bigint NOT NULL, "Status" text NOT NULL, "Error" text NOT NULL, "UpdatedAt" timestamp with time zone NOT NULL,
            PRIMARY KEY ("UserId", "DeviceId", "PluginId")
        );
        CREATE TABLE IF NOT EXISTS aigc_hub."DshFailures" (
            "Id" uuid PRIMARY KEY, "UserId" uuid NOT NULL REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE,
            "EventId" uuid NOT NULL, "DeviceId" text NOT NULL, "AppVersion" text NOT NULL,
            "Category" text NOT NULL, "Operation" text NOT NULL, "SessionId" text NOT NULL, "OperationId" text NOT NULL,
            "OccurredAt" timestamp with time zone NOT NULL, "ReceivedAt" timestamp with time zone NOT NULL, "PayloadJson" text NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_DshFailures_UserId_EventId" ON aigc_hub."DshFailures" ("UserId", "EventId");
        ALTER TABLE aigc_hub."DshFailures" ALTER COLUMN "UserId" DROP NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_DshFailures_Installer_EventId" ON aigc_hub."DshFailures" ("EventId") WHERE "UserId" IS NULL;
        CREATE INDEX IF NOT EXISTS "IX_DshFailures_OccurredAt" ON aigc_hub."DshFailures" ("OccurredAt");
        CREATE INDEX IF NOT EXISTS "IX_DshFailures_UserId_OccurredAt" ON aigc_hub."DshFailures" ("UserId", "OccurredAt");
        CREATE TABLE IF NOT EXISTS aigc_hub."DesktopAnnouncements" (
            "Id" uuid NOT NULL,
            "Title" text NOT NULL,
            "Body" text NOT NULL,
            "Important" boolean NOT NULL,
            "Status" text NOT NULL,
            "StartsAt" timestamp with time zone NOT NULL,
            "EndsAt" timestamp with time zone NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_DesktopAnnouncements" PRIMARY KEY ("Id")
        );
        CREATE TABLE IF NOT EXISTS aigc_hub."DesktopAnnouncementRecipients" (
            "AnnouncementId" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            "DeliveredAt" timestamp with time zone NULL,
            "ReadAt" timestamp with time zone NULL,
            "ConfirmedAt" timestamp with time zone NULL,
            CONSTRAINT "PK_DesktopAnnouncementRecipients" PRIMARY KEY ("AnnouncementId", "UserId"),
            FOREIGN KEY ("AnnouncementId") REFERENCES aigc_hub."DesktopAnnouncements" ("Id") ON DELETE CASCADE,
            FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS aigc_hub."DesktopReleases" (
            "Id" uuid NOT NULL,
            "Version" text NOT NULL,
            "Notes" text NOT NULL,
            "Platform" text NOT NULL,
            "Arch" text NOT NULL,
            "Status" text NOT NULL,
            "FileName" text NOT NULL,
            "Sha512" text NOT NULL,
            "Bytes" bigint NOT NULL,
            "HasBlockmap" boolean NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_DesktopReleases" PRIMARY KEY ("Id")
        );
        CREATE TABLE IF NOT EXISTS aigc_hub."DesktopReleaseRecipients" (
            "ReleaseId" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            CONSTRAINT "PK_DesktopReleaseRecipients" PRIMARY KEY ("ReleaseId", "UserId"),
            FOREIGN KEY ("ReleaseId") REFERENCES aigc_hub."DesktopReleases" ("Id") ON DELETE CASCADE,
            FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS aigc_hub."DesktopClientReports" (
            "UserId" uuid NOT NULL,
            "DeviceId" text NOT NULL,
            "ComputerName" text NOT NULL,
            "Version" text NOT NULL,
            "Platform" text NOT NULL,
            "Arch" text NOT NULL,
            "UpdateStatus" text NOT NULL,
            "TargetVersion" text NOT NULL,
            "Error" text NOT NULL,
            "LastSeenAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_DesktopClientReports" PRIMARY KEY ("UserId", "DeviceId"),
            FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_DesktopReleases_Version_Platform_Arch" ON aigc_hub."DesktopReleases" ("Version", "Platform", "Arch");
        ALTER TABLE aigc_hub."DesktopAnnouncements" ADD COLUMN IF NOT EXISTS "AudienceJson" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."DesktopReleases" ADD COLUMN IF NOT EXISTS "AudienceJson" text NOT NULL DEFAULT '';

        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "RepositoryUrl" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "Branch" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "CommitSha" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "Version" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "Environment" text NOT NULL DEFAULT 'Production';
        ALTER TABLE aigc_hub."PublicationRequests" ADD COLUMN IF NOT EXISTS "AccessMode" text NOT NULL DEFAULT 'All';
        ALTER TABLE aigc_hub."ChatConversations" ADD COLUMN IF NOT EXISTS "ModelConfigurationId" uuid NULL;
        ALTER TABLE aigc_hub."ChatConversations" ADD COLUMN IF NOT EXISTS "IsArchived" boolean NOT NULL DEFAULT false;

        CREATE TABLE IF NOT EXISTS aigc_hub."ModelConfigurations" (
            "Id" uuid NOT NULL,
            "Name" text NOT NULL,
            "ProviderKind" text NOT NULL,
            "Protocol" text NOT NULL,
            "BaseUrl" text NOT NULL,
            "EndpointPath" text NOT NULL,
            "ModelIdentifier" text NOT NULL,
            "ApiKeyProtected" text NOT NULL,
            "AuthType" text NOT NULL,
            "ApiKeyHeader" text NOT NULL,
            "SupportsTools" boolean NOT NULL,
            "IsEnabled" boolean NOT NULL,
            "IsDefault" boolean NOT NULL,
            "Temperature" double precision NOT NULL,
            "MaxTokens" integer NULL,
            "SortOrder" integer NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            "UpdatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_ModelConfigurations" PRIMARY KEY ("Id")
        );
        ALTER TABLE aigc_hub."Users" ALTER COLUMN "DepartmentId" DROP NOT NULL;
        ALTER TABLE aigc_hub."ModelConfigurations" ADD COLUMN IF NOT EXISTS "Multiplier" text NOT NULL DEFAULT '';
        ALTER TABLE aigc_hub."ModelConfigurations" ADD COLUMN IF NOT EXISTS "ImageInputMode" text NOT NULL DEFAULT 'Auto';
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_ModelConfigurations_Name" ON aigc_hub."ModelConfigurations" ("Name");

        CREATE TABLE IF NOT EXISTS aigc_hub."UserModelGrants" (
            "UserId" uuid NOT NULL,
            "ModelId" uuid NOT NULL,
            CONSTRAINT "PK_UserModelGrants" PRIMARY KEY ("UserId", "ModelId"),
            CONSTRAINT "FK_UserModelGrants_Users_UserId" FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE,
            CONSTRAINT "FK_UserModelGrants_ModelConfigurations_ModelId" FOREIGN KEY ("ModelId") REFERENCES aigc_hub."ModelConfigurations" ("Id") ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS aigc_hub."AccessGrants" (
            "ResourceKey" text NOT NULL,
            "SubjectType" text NOT NULL,
            "SubjectId" uuid NOT NULL,
            CONSTRAINT "PK_AccessGrants" PRIMARY KEY ("ResourceKey", "SubjectType", "SubjectId")
        );

        CREATE TABLE IF NOT EXISTS aigc_hub."WebSearchConfigurations" (
            "Id" integer NOT NULL,
            "ApiKeyProtected" text NOT NULL,
            "IsEnabled" boolean NOT NULL,
            CONSTRAINT "PK_WebSearchConfigurations" PRIMARY KEY ("Id")
        );

        CREATE TABLE IF NOT EXISTS aigc_hub."DshAccessTokens" (
            "TokenHash" text NOT NULL,
            "UserId" uuid NOT NULL,
            "ExpiresAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_DshAccessTokens" PRIMARY KEY ("TokenHash"),
            CONSTRAINT "FK_DshAccessTokens_Users_UserId" FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IX_DshAccessTokens_ExpiresAt" ON aigc_hub."DshAccessTokens" ("ExpiresAt");
        ALTER TABLE aigc_hub."DshAccessTokens" ADD COLUMN IF NOT EXISTS "PersistentSessionId" uuid NULL;
        CREATE TABLE IF NOT EXISTS aigc_hub."DshPersistentSessions" (
            "Id" uuid PRIMARY KEY, "UserId" uuid NOT NULL REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE,
            "RefreshTokenHash" text NOT NULL, "CreatedAt" timestamp with time zone NOT NULL, "Revoked" boolean NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_DshPersistentSessions_RefreshTokenHash" ON aigc_hub."DshPersistentSessions" ("RefreshTokenHash");

        CREATE TABLE IF NOT EXISTS aigc_hub."DshUploads" (
            "Id" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            "ClientUploadId" text NOT NULL,
            "SessionId" text NOT NULL,
            "EventSeq" bigint NOT NULL,
            "Prompt" text NOT NULL,
            "DeviceId" text NOT NULL,
            "ComputerName" text NOT NULL,
            "StoredPath" text NOT NULL,
            "FileName" text NOT NULL,
            "Sha256" text NOT NULL,
            "Bytes" bigint NOT NULL,
            "Offset" bigint NOT NULL,
            "Completed" boolean NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            "CompletedAt" timestamp with time zone NULL,
            CONSTRAINT "PK_DshUploads" PRIMARY KEY ("Id"),
            CONSTRAINT "FK_DshUploads_Users_UserId" FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_DshUploads_UserId_ClientUploadId" ON aigc_hub."DshUploads" ("UserId", "ClientUploadId");

        CREATE TABLE IF NOT EXISTS aigc_hub."SensitiveWords" (
            "Id" uuid NOT NULL,
            "Term" text NOT NULL,
            "NormalizedTerm" text NOT NULL,
            "IsEnabled" boolean NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            "UpdatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_SensitiveWords" PRIMARY KEY ("Id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_SensitiveWords_NormalizedTerm"
            ON aigc_hub."SensitiveWords" ("NormalizedTerm");

        CREATE TABLE IF NOT EXISTS aigc_hub."PublicationAccessGrants" (
            "Id" uuid NOT NULL,
            "PublicationRequestId" uuid NOT NULL,
            "SubjectType" text NOT NULL,
            "SubjectId" uuid NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_PublicationAccessGrants" PRIMARY KEY ("Id"),
            CONSTRAINT "FK_PublicationAccessGrants_PublicationRequests_PublicationRequestId"
                FOREIGN KEY ("PublicationRequestId") REFERENCES aigc_hub."PublicationRequests" ("Id") ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_PublicationAccessGrants_PublicationRequestId_SubjectType_SubjectId"
            ON aigc_hub."PublicationAccessGrants" ("PublicationRequestId", "SubjectType", "SubjectId");

        CREATE TABLE IF NOT EXISTS aigc_hub."ChatConversations" (
            "Id" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            "Title" text NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            "UpdatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_ChatConversations" PRIMARY KEY ("Id"),
            CONSTRAINT "FK_ChatConversations_Users_UserId" FOREIGN KEY ("UserId") REFERENCES aigc_hub."Users" ("Id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IX_ChatConversations_UserId_UpdatedAt" ON aigc_hub."ChatConversations" ("UserId", "UpdatedAt");

        CREATE TABLE IF NOT EXISTS aigc_hub."ChatMessages" (
            "Id" uuid NOT NULL,
            "ConversationId" uuid NOT NULL,
            "Role" text NOT NULL,
            "Content" text NOT NULL,
            "ToolExecutionId" uuid NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_ChatMessages" PRIMARY KEY ("Id"),
            CONSTRAINT "FK_ChatMessages_ChatConversations_ConversationId" FOREIGN KEY ("ConversationId") REFERENCES aigc_hub."ChatConversations" ("Id") ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "IX_ChatMessages_ConversationId" ON aigc_hub."ChatMessages" ("ConversationId");

        CREATE TABLE IF NOT EXISTS aigc_hub."ChatToolExecutions" (
            "Id" uuid NOT NULL,
            "ConversationId" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            "ToolName" text NOT NULL,
            "ArgumentsJson" text NOT NULL,
            "Status" integer NOT NULL,
            "RequiresConfirmation" boolean NOT NULL,
            "ResultJson" text NULL,
            "Error" text NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            "ConfirmedAt" timestamp with time zone NULL,
            "CompletedAt" timestamp with time zone NULL,
            CONSTRAINT "PK_ChatToolExecutions" PRIMARY KEY ("Id")
        );
        CREATE INDEX IF NOT EXISTS "IX_ChatToolExecutions_UserId_CreatedAt" ON aigc_hub."ChatToolExecutions" ("UserId", "CreatedAt");

        CREATE TABLE IF NOT EXISTS aigc_hub."OperationAudits" (
            "Id" uuid NOT NULL,
            "UserId" uuid NOT NULL,
            "Action" text NOT NULL,
            "EntityType" text NOT NULL,
            "EntityId" text NULL,
            "DetailJson" text NOT NULL,
            "Succeeded" boolean NOT NULL,
            "CreatedAt" timestamp with time zone NOT NULL,
            CONSTRAINT "PK_OperationAudits" PRIMARY KEY ("Id")
        );
        CREATE INDEX IF NOT EXISTS "IX_OperationAudits_UserId_CreatedAt" ON aigc_hub."OperationAudits" ("UserId", "CreatedAt");

        CREATE TABLE IF NOT EXISTS aigc_hub."ManagedVirtualKeys" (
            "Id" uuid NOT NULL PRIMARY KEY, "Alias" text NOT NULL, "KeyProtected" text NOT NULL,
            "IsEnabled" boolean NOT NULL, "CreatedAt" timestamp with time zone NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_ManagedVirtualKeys_Alias" ON aigc_hub."ManagedVirtualKeys" ("Alias");
        CREATE TABLE IF NOT EXISTS aigc_hub."VirtualKeyOrganizations" (
            "Id" uuid NOT NULL PRIMARY KEY, "Name" text NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS "IX_VirtualKeyOrganizations_Name" ON aigc_hub."VirtualKeyOrganizations" ("Name");
        CREATE TABLE IF NOT EXISTS aigc_hub."VirtualKeyOrganizationMembers" (
            "OrganizationId" uuid NOT NULL, "UserId" uuid NOT NULL,
            PRIMARY KEY ("OrganizationId", "UserId"));
        """;
        await db.Database.ExecuteSqlRawAsync(sql, ct);
    }
}
