-------------------------------------------------------------------------------
-- Observability, silent-failure metrics, and staged rollout — Migration 026
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_decision_ledger (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                 UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_role          TEXT NOT NULL,
  action_considered      TEXT NOT NULL,
  decision               TEXT NOT NULL,
  reason_code            TEXT NOT NULL,
  reason_summary         TEXT NOT NULL,
  confidence_score       NUMERIC(4,3) NOT NULL,
  confidence_breakdown   JSONB,
  entity_id              UUID REFERENCES entities(id) ON DELETE SET NULL,
  work_item_id           UUID REFERENCES work_items(id) ON DELETE SET NULL,
  autonomy_tier          INTEGER,
  context_payload        JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_decision_ledger_decision_chk CHECK (
    decision IN ('executed','deferred','declined','escalated','suppressed')
  ),
  CONSTRAINT agent_decision_ledger_confidence_chk CHECK (
    confidence_score >= 0 AND confidence_score <= 1
  )
);

ALTER TABLE agent_decision_ledger
  ADD COLUMN IF NOT EXISTS workflow_id TEXT,
  ADD COLUMN IF NOT EXISTS run_id TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_recent
  ON agent_decision_ledger (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_reason
  ON agent_decision_ledger (org_id, reason_code, created_at DESC);

ALTER TABLE agent_decision_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_decision_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_decision_ledger_org_isolation ON agent_decision_ledger;
CREATE POLICY agent_decision_ledger_org_isolation ON agent_decision_ledger
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_decision_ledger TO darex_app;

CREATE TABLE IF NOT EXISTS operational_expectations (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  object_type             TEXT NOT NULL,
  object_id               TEXT NOT NULL,
  expected_state          TEXT NOT NULL,
  expected_by_timestamp   TIMESTAMPTZ NOT NULL,
  actual_state            TEXT NOT NULL DEFAULT 'pending',
  basis                   TEXT NOT NULL,
  source_loop_id          UUID,
  is_discrepancy          BOOLEAN NOT NULL DEFAULT FALSE,
  discrepancy_magnitude   TEXT,
  work_item_id            UUID REFERENCES work_items(id) ON DELETE SET NULL,
  discrepancy_resolved_at TIMESTAMPTZ,
  settled_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operational_expectations_basis_chk CHECK (
    basis IN ('promise','declared','inferred')
  )
);

ALTER TABLE operational_expectations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_expectations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operational_expectations_org_isolation ON operational_expectations;
CREATE POLICY operational_expectations_org_isolation ON operational_expectations
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON operational_expectations TO darex_app;

CREATE TABLE IF NOT EXISTS agent_open_loops (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                 UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id        UUID REFERENCES conversations(id) ON DELETE SET NULL,
  entity_id              UUID REFERENCES entities(id) ON DELETE SET NULL,
  customer_identifier    TEXT NOT NULL,
  obligor                TEXT NOT NULL,
  promise_summary        TEXT NOT NULL,
  source_quote           TEXT NOT NULL,
  source_message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  status                 TEXT NOT NULL DEFAULT 'waiting',
  target_check_at        TIMESTAMPTZ NOT NULL,
  due_basis              TEXT NOT NULL,
  assigned_employee_role TEXT NOT NULL,
  confidence             NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  content_hash           TEXT NOT NULL,
  chase_count            INTEGER NOT NULL DEFAULT 0,
  resolution_notes       TEXT,
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_open_loops_obligor_chk CHECK (obligor IN ('us','them')),
  CONSTRAINT agent_open_loops_status_chk CHECK (
    status IN ('waiting','scheduled','monitoring','escalated','closed')
  ),
  CONSTRAINT agent_open_loops_due_basis_chk CHECK (
    due_basis IN ('explicit','relative','default')
  ),
  CONSTRAINT agent_open_loops_confidence_chk CHECK (
    confidence >= 0 AND confidence <= 1
  )
);

ALTER TABLE agent_open_loops
  ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_open_loops_content
  ON agent_open_loops (org_id, content_hash);

ALTER TABLE agent_open_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_open_loops FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_open_loops_org_isolation ON agent_open_loops;
CREATE POLICY agent_open_loops_org_isolation ON agent_open_loops
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_open_loops TO darex_app;

CREATE TABLE IF NOT EXISTS agent_pending_actions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workflow_id    TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  employee_role  TEXT NOT NULL,
  payload        JSONB NOT NULL,
  token_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  work_item_id   UUID REFERENCES work_items(id) ON DELETE SET NULL,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  decided_at     TIMESTAMPTZ,
  decided_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_pending_actions_status_chk CHECK (
    status IN ('pending','approved','rejected','expired')
  ),
  CONSTRAINT agent_pending_actions_decided_chk CHECK (
    (status = 'pending') = (decided_at IS NULL)
  )
);

ALTER TABLE agent_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_pending_actions_org_isolation ON agent_pending_actions;
CREATE POLICY agent_pending_actions_org_isolation ON agent_pending_actions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_pending_actions TO darex_app;

CREATE TABLE IF NOT EXISTS employee_autonomy_rules (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  action_type             TEXT NOT NULL,
  employee_role           TEXT,
  autonomy_tier           INTEGER NOT NULL,
  reversibility           TEXT NOT NULL DEFAULT 'reversible',
  requires_human_approval BOOLEAN NOT NULL DEFAULT FALSE,
  confidence_threshold    NUMERIC(4,3) NOT NULL DEFAULT 0.850,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_autonomy_rules_tier_chk CHECK (autonomy_tier BETWEEN 1 AND 4),
  CONSTRAINT employee_autonomy_rules_reversibility_chk CHECK (
    reversibility IN ('reversible','visible','irreversible')
  ),
  CONSTRAINT employee_autonomy_rules_irreversible_chk CHECK (
    reversibility <> 'irreversible' OR requires_human_approval = TRUE
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_autonomy_rules_action
  ON employee_autonomy_rules (org_id, action_type, COALESCE(employee_role, '*'));

ALTER TABLE employee_autonomy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_autonomy_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_autonomy_rules_org_isolation ON employee_autonomy_rules;
CREATE POLICY employee_autonomy_rules_org_isolation ON employee_autonomy_rules
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_autonomy_rules TO darex_app;

CREATE TABLE IF NOT EXISTS org_runtime_controls (
  org_id          UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  kill_switch     BOOLEAN NOT NULL DEFAULT FALSE,
  autonomy_stage  INTEGER NOT NULL DEFAULT 0,
  shadow_reviewed INTEGER NOT NULL DEFAULT 0,
  shadow_agreed   INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_runtime_controls_stage_chk CHECK (autonomy_stage BETWEEN 0 AND 3)
);

ALTER TABLE org_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_runtime_controls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_runtime_controls_org_isolation ON org_runtime_controls;
CREATE POLICY org_runtime_controls_org_isolation ON org_runtime_controls
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_runtime_controls TO darex_app;

CREATE TABLE IF NOT EXISTS org_employee_metrics_daily (
  org_id                         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  metric_date                    DATE NOT NULL,
  employee_role                  TEXT NOT NULL DEFAULT '*',
  approval_rate                  NUMERIC,
  escalation_rate                NUMERIC,
  time_to_decision_p50_hours     NUMERIC,
  expiry_rate                    NUMERIC,
  obligations_per_100_messages   NUMERIC,
  grounding_rejection_rate       NUMERIC,
  open_discrepancies             INTEGER,
  discrepancy_zero_days          INTEGER,
  autonomous_action_share        NUMERIC,
  suppression_rate               NUMERIC,
  outbound_per_customer          NUMERIC,
  outbound_cap                   NUMERIC,
  confidence_calibration_drift   NUMERIC,
  band_alerts                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, metric_date, employee_role)
);

ALTER TABLE org_employee_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_employee_metrics_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_employee_metrics_daily_org_isolation ON org_employee_metrics_daily;
CREATE POLICY org_employee_metrics_daily_org_isolation ON org_employee_metrics_daily
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_employee_metrics_daily TO darex_app;
