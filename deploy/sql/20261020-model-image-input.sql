-- Review before applying to production. This script does not enable images on any model.
-- Expected changes: one additive column if absent; zero INSERT/UPDATE/DELETE model rows.
-- Existing models retain their IDs, identifiers, authorization, keys and routing.
-- New column defaults to Auto. Configure exact, verified deployments through model management.

-- Preview identifiers and aliases. Duplicate identifiers are informational: local routes may differ.
SELECT COUNT(*) AS model_count, COUNT(DISTINCT "Id") AS unique_ids
FROM aigc_hub."ModelConfigurations";
SELECT "ProviderKind", "ModelIdentifier", COUNT(*) AS deployments
FROM aigc_hub."ModelConfigurations"
GROUP BY "ProviderKind", "ModelIdentifier" HAVING COUNT(*) > 1;
SELECT "Id", "Name", "ProviderKind", "ModelIdentifier", "IsEnabled"
FROM aigc_hub."ModelConfigurations"
WHERE lower("ModelIdentifier") IN ('glm-5.3-flash', 'deepseek-flash', 'deepseek-v4.1-flash', 'qwen3.8-flash')
ORDER BY "ProviderKind", "Name";

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE aigc_hub."ModelConfigurations"
    ADD COLUMN IF NOT EXISTS "ImageInputMode" text NOT NULL DEFAULT 'Auto';
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM aigc_hub."ModelConfigurations"
               WHERE "ImageInputMode" NOT IN ('Auto', 'Supported', 'Unsupported') OR "ImageInputMode" IS NULL) THEN
        RAISE EXCEPTION 'Invalid pre-existing ImageInputMode; inspect schema/data before proceeding';
    END IF;
END $$;
SELECT "ImageInputMode", COUNT(*) FROM aigc_hub."ModelConfigurations" GROUP BY "ImageInputMode";
COMMIT;

-- Rollback application binaries first. The additive column can safely remain for old binaries.
-- Only after backing up any explicit settings, optionally remove it in a separate reviewed change:
-- ALTER TABLE aigc_hub."ModelConfigurations" DROP COLUMN "ImageInputMode";
