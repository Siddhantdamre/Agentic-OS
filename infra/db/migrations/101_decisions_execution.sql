-------------------------------------------------------------------------------
-- Decisions — execution tracking, dual-approval counters, role gates
-- Expands agent_pending_actions status for executed / execution_failed.
-- File: infra/db/migrations/101_decisions_execution.sql
-------------------------------------------------------------------------------

ALTER TABLE agent_pending_actions
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_result JSONB,
  ADD COLUMN IF NOT EXISTS execution_error TEXT,
  ADD COLUMN IF NOT EXISTS modified_payload JSONB,
  ADD COLUMN IF NOT EXISTS required_role TEXT NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS required_approvals INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Expand status CHECK to include post-approval execution outcomes.
ALTER TABLE agent_pending_actions DROP CONSTRAINT IF EXISTS agent_pending_actions_status_chk;
ALTER TABLE agent_pending_actions
  ADD CONSTRAINT agent_pending_actions_status_chk CHECK (
    status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'execution_failed')
  );

-- decided_chk: pending <=> decided_at IS NULL. executed/execution_failed keep decided_at.
ALTER TABLE agent_pending_actions DROP CONSTRAINT IF EXISTS agent_pending_actions_decided_chk;
ALTER TABLE agent_pending_actions
  ADD CONSTRAINT agent_pending_actions_decided_chk CHECK (
    (status = 'pending') = (decided_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_execution
  ON agent_pending_actions (org_id, status)
  WHERE status IN ('approved', 'pending');

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_expiry
  ON agent_pending_actions (expires_at)
  WHERE status = 'pending';

COMMENT ON COLUMN agent_pending_actions.executed_at IS
  'When the parked tool actually ran after human approval.';
COMMENT ON COLUMN agent_pending_actions.required_approvals IS
  'Dual-auth: number of distinct owner/admin approvals required before execute (default 1).';
