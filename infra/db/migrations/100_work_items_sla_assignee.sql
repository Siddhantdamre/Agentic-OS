-------------------------------------------------------------------------------
-- Work items — human assignee, dependency chains, SLA breach tracking
-- Additive. Assignee must be an org users row (enforced in API + FK).
-- SLA timestamps are only written when a real breach is detected by the sweeper.
-- File: infra/db/migrations/100_work_items_sla_assignee.sql
-------------------------------------------------------------------------------

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depends_on_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_work_items_assignee_user
  ON work_items (org_id, assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_items_depends_on
  ON work_items (org_id, depends_on_id)
  WHERE depends_on_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_items_sla_open
  ON work_items (org_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL AND sla_breached_at IS NULL
    AND status NOT IN ('done', 'cancelled', 'completed');

COMMENT ON COLUMN work_items.assignee_user_id IS
  'Human specialist assignee (users.id in the same org). Distinct from AI assignee_employee_id.';
COMMENT ON COLUMN work_items.depends_on_id IS
  'Prerequisite work item in the same org. Dependent work should wait until dependency is done.';
COMMENT ON COLUMN work_items.sla_due_at IS
  'When this item is due under SLA. NULL means no SLA clock.';
COMMENT ON COLUMN work_items.sla_breached_at IS
  'Set by the SLA sweeper to NOW() only when sla_due_at has passed — never fabricated.';
