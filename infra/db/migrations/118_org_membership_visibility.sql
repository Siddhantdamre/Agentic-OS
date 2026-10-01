-------------------------------------------------------------------------------
-- Membership-visible orgs SELECT + billing role on human role CHECKs.
-- File: infra/db/migrations/118_org_membership_visibility.sql
-------------------------------------------------------------------------------

-- SELECT any org the session user belongs to (needed for workspace switch).
-- UPDATE/DELETE stay pinned to app.current_org_id (097).
DROP POLICY IF EXISTS orgs_member_select ON orgs;
CREATE POLICY orgs_member_select ON orgs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM organization_memberships om
       WHERE om.org_id = orgs.id
         AND om.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  );

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_human_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_human_role_check;
ALTER TABLE org_invites
  ADD CONSTRAINT org_invites_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));

-- 097 declares CHECK inline on organization_memberships.role; drop that
-- predicate by looking it up so a guessed name cannot leave both CHECKs.
DO $$
DECLARE
  con_name text;
BEGIN
  FOR con_name IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'organization_memberships'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%role%owner%admin%member%auditor%'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%billing%'
  LOOP
    EXECUTE format('ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS %I', con_name);
  END LOOP;
END
$$;

ALTER TABLE organization_memberships DROP CONSTRAINT IF EXISTS organization_memberships_role_check;
ALTER TABLE organization_memberships
  ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor', 'billing'));
