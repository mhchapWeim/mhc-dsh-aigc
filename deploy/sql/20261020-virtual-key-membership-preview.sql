-- READ ONLY: expected data changes = 0. Disabled keys and users retain their reservations.
-- IDs/aliases and current memberships are inspected; no automatic reassignment is performed.
SELECT COUNT(*) AS key_count, COUNT(DISTINCT "Id") AS unique_key_ids
FROM aigc_hub."ManagedVirtualKeys";

WITH effective_members AS (
    SELECT k."Id" AS key_id, k."Alias" AS key_alias, g."SubjectId" AS user_id
    FROM aigc_hub."ManagedVirtualKeys" k
    JOIN aigc_hub."AccessGrants" g ON g."ResourceKey" = 'virtual-key:' || k."Id"::text
    WHERE g."SubjectType" = 'User'
    UNION
    SELECT k."Id", k."Alias", u."Id"
    FROM aigc_hub."ManagedVirtualKeys" k
    JOIN aigc_hub."AccessGrants" g ON g."ResourceKey" = 'virtual-key:' || k."Id"::text
    JOIN aigc_hub."Users" u ON u."DepartmentId" = g."SubjectId"
    WHERE g."SubjectType" = 'Department'
    UNION
    SELECT k."Id", k."Alias", ur."UserId"
    FROM aigc_hub."ManagedVirtualKeys" k
    JOIN aigc_hub."AccessGrants" g ON g."ResourceKey" = 'virtual-key:' || k."Id"::text
    JOIN aigc_hub."UserRoles" ur ON ur."RoleId" = g."SubjectId"
    WHERE g."SubjectType" = 'Role'
    UNION
    SELECT k."Id", k."Alias", m."UserId"
    FROM aigc_hub."ManagedVirtualKeys" k
    JOIN aigc_hub."AccessGrants" g ON g."ResourceKey" = 'virtual-key:' || k."Id"::text
    JOIN aigc_hub."VirtualKeyOrganizationMembers" m ON m."OrganizationId" = g."SubjectId"
    WHERE g."SubjectType" = 'Organization'
)
SELECT u."Id", u."EmployeeNo", u."Name", COUNT(DISTINCT e.key_id) AS key_groups,
       array_agg(DISTINCT e.key_alias) AS key_aliases
FROM effective_members e
JOIN aigc_hub."Users" u ON u."Id" = e.user_id
GROUP BY u."Id", u."EmployeeNo", u."Name"
HAVING COUNT(DISTINCT e.key_id) > 1
ORDER BY u."EmployeeNo";

SELECT m."UserId", array_agg(o."Name") AS legacy_groups
FROM aigc_hub."VirtualKeyOrganizationMembers" m
JOIN aigc_hub."VirtualKeyOrganizations" o ON o."Id" = m."OrganizationId"
GROUP BY m."UserId" HAVING COUNT(DISTINCT m."OrganizationId") > 1;
