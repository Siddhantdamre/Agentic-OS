-------------------------------------------------------------------------------
-- Human roles — Migration 019 (WS-16 / E6)
-- Product RBAC: owner / admin / member / auditor.
-- Auditor cannot call pay tools (enforced in /api/agent/tools).
-- Legacy users.role default was 'agent' (001); map to member.
-- File: infra/db/migrations/019_human_roles.sql
-------------------------------------------------------------------------------

UPDATE users
   SET role = 'member'
 WHERE role IS NULL
    OR btrim(role) = ''
    OR lower(role) NOT IN ('owner', 'admin', 'member', 'auditor');

UPDATE users
   SET role = 'member'
 WHERE lower(role) = 'agent';

ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'member';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_human_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor'));

UPDATE org_invites
   SET role = 'member'
 WHERE role IS NULL
    OR btrim(role) = ''
    OR lower(role) NOT IN ('owner', 'admin', 'member', 'auditor');

ALTER TABLE org_invites DROP CONSTRAINT IF EXISTS org_invites_human_role_check;
ALTER TABLE org_invites
  ADD CONSTRAINT org_invites_human_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'auditor'));
