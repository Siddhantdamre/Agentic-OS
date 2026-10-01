-- Per-employee decision attribution. The ledger only carried employee_role, so
-- two employees sharing a role were blended in every approval-rate figure.
-- employee_id is nullable on purpose: rows written before this migration, and
-- sweeps that act on behalf of a role rather than one employee, have no
-- single owner and must stay null rather than be guessed.
-- RLS is unchanged (org_id policy from 023/037 still covers the new column).

ALTER TABLE agent_decision_ledger
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES ai_employees(id) ON DELETE SET NULL;

-- Backfill only where the id is derivable: the tool gate recorded the acting
-- employee in context_payload->>'employeeId'. Require a well-formed uuid that
-- belongs to the same org so a stale or foreign id is never linked.
UPDATE agent_decision_ledger l
   SET employee_id = e.id
  FROM ai_employees e
 WHERE l.employee_id IS NULL
   AND l.context_payload ->> 'employeeId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND e.id = (l.context_payload ->> 'employeeId')::uuid
   AND e.org_id = l.org_id;

CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_employee
  ON agent_decision_ledger (org_id, employee_id, created_at DESC)
  WHERE employee_id IS NOT NULL;

COMMENT ON COLUMN agent_decision_ledger.employee_id IS
  'Acting ai_employees.id when one employee is responsible; NULL for legacy rows and role-level sweeps.';
