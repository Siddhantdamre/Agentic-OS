-------------------------------------------------------------------------------
-- Ask AI — record partial-failure compensation log on agent_plans
-- When a mid-plan step fails after earlier successes, execute writes a freeze
-- entry here and status=completed_with_errors (never "completed").
-- Full external undo of connector side-effects is out of scope (tool-executor).
-- File: infra/db/migrations/105_ask_ai_plan_compensation.sql
-------------------------------------------------------------------------------

ALTER TABLE agent_plans
  ADD COLUMN IF NOT EXISTS compensation_steps JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN agent_plans.compensation_steps IS
  'Saga freeze log: prior succeeded steps + failed step when a plan stops early. Not an automatic external undo ledger.';
