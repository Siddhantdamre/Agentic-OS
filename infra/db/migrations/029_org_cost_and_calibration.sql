-------------------------------------------------------------------------------
-- Org cost ceilings and calibration feedback — Migration 029
--
-- Gap 21: per-org spend ceilings and daily model-spend rollup.
-- Gap 13 §7: outcome_feedback joins the decision ledger for calibration.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_cost_ceilings (
  org_id                       UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  max_model_calls_per_trigger  INTEGER NOT NULL DEFAULT 8,
  max_actions_per_sweep        INTEGER NOT NULL DEFAULT 50,
  max_spend_cents_per_day      INTEGER NOT NULL DEFAULT 2500,
  escalate_only                BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_cost_ceilings_calls_chk CHECK (max_model_calls_per_trigger BETWEEN 1 AND 64),
  CONSTRAINT org_cost_ceilings_sweep_chk CHECK (max_actions_per_sweep BETWEEN 1 AND 500),
  CONSTRAINT org_cost_ceilings_spend_chk CHECK (max_spend_cents_per_day >= 0)
);

ALTER TABLE org_cost_ceilings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_cost_ceilings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_cost_ceilings_org_isolation ON org_cost_ceilings;
CREATE POLICY org_cost_ceilings_org_isolation ON org_cost_ceilings
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_cost_ceilings TO darex_app;

CREATE TABLE IF NOT EXISTS org_model_spend (
  org_id                  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  spend_date              DATE NOT NULL,
  model_calls             INTEGER NOT NULL DEFAULT 0,
  spend_cents             INTEGER NOT NULL DEFAULT 0,
  sweep_model_calls       INTEGER NOT NULL DEFAULT 0,
  extraction_model_calls  INTEGER NOT NULL DEFAULT 0,
  obligations_extracted   INTEGER NOT NULL DEFAULT 0,
  idle_sweep_passes       INTEGER NOT NULL DEFAULT 0,
  busy_sweep_passes       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, spend_date)
);

ALTER TABLE org_model_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_model_spend FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_model_spend_org_isolation ON org_model_spend;
CREATE POLICY org_model_spend_org_isolation ON org_model_spend
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_model_spend TO darex_app;

CREATE TABLE IF NOT EXISTS outcome_feedback (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  decision_id  UUID NOT NULL REFERENCES agent_decision_ledger(id) ON DELETE CASCADE,
  reverted     BOOLEAN NOT NULL DEFAULT FALSE,
  complained   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outcome_feedback_decision
  ON outcome_feedback (org_id, decision_id);

ALTER TABLE outcome_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outcome_feedback_org_isolation ON outcome_feedback;
CREATE POLICY outcome_feedback_org_isolation ON outcome_feedback
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON outcome_feedback TO darex_app;
