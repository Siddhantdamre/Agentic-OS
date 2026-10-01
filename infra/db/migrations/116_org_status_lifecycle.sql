-------------------------------------------------------------------------------
-- Org access lifecycle: constrained status + suspension metadata.
-- File: infra/db/migrations/116_org_status_lifecycle.sql
-------------------------------------------------------------------------------

UPDATE orgs
   SET status = CASE lower(btrim(status))
     WHEN 'provisioning' THEN 'provisioning'
     WHEN 'active' THEN 'active'
     WHEN 'past_due' THEN 'past_due'
     WHEN 'suspended' THEN 'suspended'
     WHEN 'paused' THEN 'suspended'
     WHEN 'soft_deleted' THEN 'soft_deleted'
     WHEN 'deleted' THEN 'soft_deleted'
     ELSE 'active'
   END;

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_status_check;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_status_check
  CHECK (status IN ('provisioning', 'active', 'past_due', 'suspended', 'soft_deleted'));

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by TEXT,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_suspended_by_check;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_suspended_by_check
  CHECK (suspended_by IS NULL OR suspended_by IN ('dunning', 'platform'));

COMMENT ON COLUMN orgs.suspended_at IS
  'When the org entered suspended status (dunning grace elapsed or platform action).';
COMMENT ON COLUMN orgs.suspended_by IS
  'Who suspended: dunning (payment) or platform (operator). Cleared only by matching authority.';
COMMENT ON COLUMN orgs.deletion_requested_at IS
  'When soft-delete was requested; purge saga is separate.';
