------------------------------------------------------------------------------
-- Agent Plans — Phase D: Reasoning + Plan-Confirm-Execute flow for Ask AI.
-- Persists a proposed multi-step agent plan + draft per user so a pending
-- plan survives a page refresh. Every table has org_id + RLS (house rule).
-- File: infra/db/migrations/007_agent_plans.sql
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_plans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  thread_id       TEXT NOT NULL DEFAULT 'ask-ai',
  summary         TEXT NOT NULL DEFAULT '',
  steps           JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'pending',
  current_step    INTEGER NOT NULL DEFAULT 0,
  draft           JSONB,
  reasoning       JSONB,
  feedback        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agent_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_plans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_plans_org_isolation ON agent_plans;
CREATE POLICY agent_plans_org_isolation ON agent_plans
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_agent_plans_org_id ON agent_plans(org_id);
CREATE INDEX IF NOT EXISTS idx_agent_plans_user_id ON agent_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_plans_status ON agent_plans(status);