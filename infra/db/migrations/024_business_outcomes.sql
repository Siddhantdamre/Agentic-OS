-- Business outcome attribution — Migration 024

-------------------------------------------------------------------------------
-- Business Outcome Attribution — Migration 024
--
-- What the employees were actually worth. Every row must trace back to a
-- decision ledger entry; an outcome that cannot be attributed is excluded
-- from the total rather than guessed at (10 P5-ROI-2).
--
-- File: infra/db/migrations/024_business_outcomes.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_roi_metrics (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_role   TEXT NOT NULL,
  metric_type     TEXT NOT NULL,
  amount_numeric  NUMERIC(12,2),
  currency        TEXT NOT NULL DEFAULT 'USD',
  reference_id    TEXT,
  -- the attribution link. NOT NULL on purpose: no ledger row, no credit.
  decision_id     UUID NOT NULL REFERENCES agent_decision_ledger(id) ON DELETE CASCADE,
  entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_roi_metrics_type_chk CHECK (
    metric_type IN (
      'pipeline_influenced','revenue_recovered','ticket_resolved_autonomously',
      'hours_saved','escalation_avoided','churn_prevented'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_employee_roi_metrics_rollup
  ON employee_roi_metrics (org_id, employee_role, metric_type, occurred_at DESC);

ALTER TABLE employee_roi_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_roi_metrics FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_roi_metrics_org_isolation ON employee_roi_metrics;
CREATE POLICY employee_roi_metrics_org_isolation ON employee_roi_metrics
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_roi_metrics TO darex_app;

COMMENT ON TABLE employee_roi_metrics IS
  'ROI attributed to a specific decision. decision_id is NOT NULL by design: '
  'an unattributable outcome is excluded, never estimated.';
