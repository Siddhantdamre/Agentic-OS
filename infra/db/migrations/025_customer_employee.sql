ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_operational_state TEXT;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS org_runtime_controls (
  org_id UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  autonomy_stage INTEGER NOT NULL DEFAULT 0,
  outbound_daily_cap INTEGER NOT NULL DEFAULT 40,
  shadow_reviewed INTEGER NOT NULL DEFAULT 0,
  shadow_agreed INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_runtime_controls_stage_chk CHECK (autonomy_stage BETWEEN 0 AND 3)
);
ALTER TABLE org_runtime_controls ADD COLUMN IF NOT EXISTS kill_switch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE org_runtime_controls ADD COLUMN IF NOT EXISTS outbound_daily_cap INTEGER NOT NULL DEFAULT 40;
ALTER TABLE org_runtime_controls ADD COLUMN IF NOT EXISTS shadow_reviewed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_runtime_controls ADD COLUMN IF NOT EXISTS shadow_agreed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE org_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_runtime_controls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_runtime_controls_org_isolation ON org_runtime_controls;
CREATE POLICY org_runtime_controls_org_isolation ON org_runtime_controls
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_runtime_controls TO darex_app;

CREATE TABLE IF NOT EXISTS platform_send_counters (
  minute_bucket TIMESTAMPTZ PRIMARY KEY,
  send_count INTEGER NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_send_counters TO darex_app;

CREATE TABLE IF NOT EXISTS conversational_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  topic TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE conversational_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversational_insights FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversational_insights_org_isolation ON conversational_insights;
CREATE POLICY conversational_insights_org_isolation ON conversational_insights
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON conversational_insights TO darex_app;

CREATE TABLE IF NOT EXISTS agent_decision_ledger_daily (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  reason_code TEXT NOT NULL,
  action_type TEXT NOT NULL,
  decision_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, reason_code, action_type)
);
ALTER TABLE agent_decision_ledger_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_decision_ledger_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_decision_ledger_daily_org_isolation ON agent_decision_ledger_daily;
CREATE POLICY agent_decision_ledger_daily_org_isolation ON agent_decision_ledger_daily
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_decision_ledger_daily TO darex_app;

CREATE TABLE IF NOT EXISTS employee_authority_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES ai_employees(id) ON DELETE CASCADE,
  action_name TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_authority_policies_type_chk CHECK (policy_type IN ('allowed','restricted','escalate_strictly'))
);
ALTER TABLE employee_authority_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_authority_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_authority_policies_org_isolation ON employee_authority_policies;
CREATE POLICY employee_authority_policies_org_isolation ON employee_authority_policies
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_authority_policies TO darex_app;

CREATE INDEX IF NOT EXISTS idx_conversations_operational_state
  ON conversations (org_id, customer_operational_state)
  WHERE customer_operational_state IS NOT NULL;
