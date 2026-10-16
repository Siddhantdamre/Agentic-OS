-------------------------------------------------------------------------------
-- Market Scout dedup ledger — Migration 031
--
-- GE-02 Market Scout needs a durable record of which Apollo-sourced leads
-- have already been scouted for an org, both to dedupe repeated searches and
-- to enforce a daily lead budget/cap per gap/17 §7 style rate limiting.
--
-- File: infra/db/migrations/031_growth_scout_leads.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS growth_scout_leads (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  contact_email  TEXT NOT NULL DEFAULT '',
  company_domain TEXT NOT NULL DEFAULT '',
  contact_name   TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  crm_synced     BOOLEAN NOT NULL DEFAULT FALSE,
  scouted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_scout_leads_org_contact
  ON growth_scout_leads (org_id, contact_email, company_domain);
CREATE INDEX IF NOT EXISTS idx_growth_scout_leads_org_scouted
  ON growth_scout_leads (org_id, scouted_at DESC);

ALTER TABLE growth_scout_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_scout_leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_scout_leads_org_isolation ON growth_scout_leads;
CREATE POLICY growth_scout_leads_org_isolation ON growth_scout_leads
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_scout_leads TO darex_app;

COMMENT ON TABLE growth_scout_leads IS
  'Market Scout dedup ledger — one row per Apollo-sourced lead already scouted, used for the daily lead budget cap.';
