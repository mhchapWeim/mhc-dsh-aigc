-- PostgreSQL reviewable migration. Do not clear any existing user's department.
-- Expected business rows inserted/updated/deleted: 0.
-- Run the preview queries first, then review the transaction before deployment.
SELECT count(*) AS users_before, count(DISTINCT "Id") AS unique_user_ids FROM aigc_hub."Users";
SELECT count(*) AS models_before, count(DISTINCT "Id") AS unique_model_ids FROM aigc_hub."ModelConfigurations";
SELECT u."Id", u."EmployeeNo", u."DepartmentId"
FROM aigc_hub."Users" u LEFT JOIN aigc_hub."Departments" d ON d."Id" = u."DepartmentId"
WHERE u."DepartmentId" IS NOT NULL AND d."Id" IS NULL; -- expected 0 rows
SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns WHERE table_schema = 'aigc_hub'
AND ((table_name = 'Users' AND column_name = 'DepartmentId')
  OR (table_name = 'ModelConfigurations' AND column_name = 'Multiplier'));

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE aigc_hub."Users" ALTER COLUMN "DepartmentId" DROP NOT NULL;
ALTER TABLE aigc_hub."ModelConfigurations" ADD COLUMN IF NOT EXISTS "Multiplier" text NOT NULL DEFAULT '';
-- Existing foreign key and primary/unique keys are preserved. No UPDATE is performed.
COMMIT;

SELECT count(*) AS users_after, count(DISTINCT "Id") AS unique_user_ids FROM aigc_hub."Users";
SELECT count(*) AS models_after, count(DISTINCT "Id") AS unique_model_ids FROM aigc_hub."ModelConfigurations";
-- Rollback of NOT NULL requires assigning all newly unassigned users a valid department first.
-- Retain Multiplier on application rollback to preserve administrator-entered text.
