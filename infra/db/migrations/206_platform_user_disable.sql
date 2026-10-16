-------------------------------------------------------------------------------
-- Platform console: disable / re-enable a user.
-- users.disabled_at is set by an operator through POST
-- /api/platform/orgs/:orgId/users/:userId/disable (audited, reason required).
-- getScopedClient() and requirePlatformAdmin() refuse a disabled user on every
-- request, and disabling also bumps session_epoch so open sessions end at once.
-- Idempotent. File: infra/db/migrations/206_platform_user_disable.sql
-------------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

COMMENT ON COLUMN users.disabled_at IS
  'Set by a platform operator. Non-null means every authenticated request is refused (401).';

-- Column-scoped, like session_epoch: the console may flip this field and nothing else new.
GRANT UPDATE (disabled_at) ON users TO darex_platform;
