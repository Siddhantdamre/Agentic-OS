-------------------------------------------------------------------------------
-- Growth Employee — Migration 028
--
-- Unique to docs/new-109-pg-plan/gap/01: lookalike ICP cache, buying signals,
-- visitor reverse-IP intent, preference filter rules, pipeline attribution,
-- and notification rate-limit log for gap/17 §7.
--
-- Does NOT recreate 023/024 tables (decision ledger, autonomy rules, pending
-- actions, ROI metrics). Those ship in 023_employee_state_machines.sql and
-- 024_business_outcomes.sql.
--
-- File: infra/db/migrations/028_growth_employee.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS autonomy_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE ask_ai_feedback
  ADD COLUMN IF NOT EXISTS comment TEXT;

ALTER TABLE ask_ai_feedback
  ADD COLUMN IF NOT EXISTS synthesized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ask_ai_feedback_unsynthesized
  ON ask_ai_feedback (org_id, synthesized_at)
  WHERE vote = 'down' AND synthesized_at IS NULL;

CREATE TABLE IF NOT EXISTS lead_intent_signals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_name   TEXT NOT NULL,
  company_domain TEXT NOT NULL DEFAULT '',
  signal_type    TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source         TEXT NOT NULL DEFAULT 'web_search',
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_intent_signals_type_chk CHECK (
    signal_type IN ('hiring', 'funding', 'leadership', 'intent', 'news', 'other')
  )
);

CREATE INDEX IF NOT EXISTS idx_lead_intent_signals_org_detected
  ON lead_intent_signals (org_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_intent_signals_org_domain
  ON lead_intent_signals (org_id, company_domain);

ALTER TABLE lead_intent_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intent_signals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_intent_signals_org_isolation ON lead_intent_signals;
CREATE POLICY lead_intent_signals_org_isolation ON lead_intent_signals
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_intent_signals TO darex_app;

CREATE TABLE IF NOT EXISTS growth_icp_profiles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  profile     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_size INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'crm',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_icp_profiles_org
  ON growth_icp_profiles (org_id);

ALTER TABLE growth_icp_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_icp_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_icp_profiles_org_isolation ON growth_icp_profiles;
CREATE POLICY growth_icp_profiles_org_isolation ON growth_icp_profiles
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_icp_profiles TO darex_app;

CREATE TABLE IF NOT EXISTS org_preferences (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rules        JSONB NOT NULL DEFAULT '[]'::jsonb,
  suppressions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_preferences_org
  ON org_preferences (org_id);

ALTER TABLE org_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_preferences_org_isolation ON org_preferences;
CREATE POLICY org_preferences_org_isolation ON org_preferences
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_preferences TO darex_app;

CREATE TABLE IF NOT EXISTS growth_pipeline_attribution (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  opportunity_work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  crm_deal_id              TEXT,
  stage                    TEXT NOT NULL DEFAULT 'created',
  estimated_value_cents    BIGINT NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL DEFAULT 'USD',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gpa_stage_chk CHECK (
    stage IN ('created', 'qualified', 'conversation', 'meeting', 'won', 'lost')
  )
);

CREATE INDEX IF NOT EXISTS idx_growth_pipeline_attr_org
  ON growth_pipeline_attribution (org_id, created_at DESC);

ALTER TABLE growth_pipeline_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_pipeline_attribution FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_pipeline_attribution_org_isolation ON growth_pipeline_attribution;
CREATE POLICY growth_pipeline_attribution_org_isolation ON growth_pipeline_attribution
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_pipeline_attribution TO darex_app;

CREATE TABLE IF NOT EXISTS visitor_company_intent (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  visitor_id          TEXT NOT NULL DEFAULT '',
  ip_hash             TEXT NOT NULL,
  company_name        TEXT NOT NULL DEFAULT '',
  company_domain      TEXT NOT NULL DEFAULT '',
  enrichment_source   TEXT NOT NULL DEFAULT 'none',
  enrichment_status   TEXT NOT NULL DEFAULT 'pending',
  pricing_page_visits INTEGER NOT NULL DEFAULT 0,
  last_path           TEXT NOT NULL DEFAULT '',
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vci_status_chk CHECK (
    enrichment_status IN ('pending', 'resolved', 'unavailable', 'error')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_visitor_company_intent_org_ip
  ON visitor_company_intent (org_id, ip_hash);
CREATE INDEX IF NOT EXISTS idx_visitor_company_intent_org_seen
  ON visitor_company_intent (org_id, last_seen_at DESC);

ALTER TABLE visitor_company_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_company_intent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visitor_company_intent_org_isolation ON visitor_company_intent;
CREATE POLICY visitor_company_intent_org_isolation ON visitor_company_intent
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON visitor_company_intent TO darex_app;

CREATE TABLE IF NOT EXISTS org_notification_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_notification_log_org
  ON org_notification_log (org_id, created_at DESC);

ALTER TABLE org_notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_notification_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_notification_log_org_isolation ON org_notification_log;
CREATE POLICY org_notification_log_org_isolation ON org_notification_log
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_notification_log TO darex_app;

COMMENT ON TABLE lead_intent_signals IS
  'External buying signals (hiring, funding, leadership, website intent).';
COMMENT ON TABLE growth_icp_profiles IS
  'Cached lookalike ICP centroid from closed-won CRM accounts.';
COMMENT ON TABLE org_preferences IS
  'Hard filter rules distilled from owner rejections. Suppressions stay inspectable.';
COMMENT ON TABLE visitor_company_intent IS
  'Reverse-IP company match plus pricing-page visit counters. Raw IPs are hashed.';
COMMENT ON TABLE growth_pipeline_attribution IS
  'Dollar pipeline stages attributed to Growth opportunities, not token spend.';
COMMENT ON TABLE org_notification_log IS
  'Rate-limit log: at most one immediate owner notification per hour per org.';
