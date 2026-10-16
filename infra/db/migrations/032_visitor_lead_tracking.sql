-------------------------------------------------------------------------------
-- Visitor lead conversion tracking — Migration 032
--
-- GE-04 Website Visitor Identifier needs to remember that a visitor row
-- already crossed the 2+ visit frequency gate and was converted into a
-- growth_opportunity lead, so the widget endpoint never creates duplicates
-- on every subsequent pricing-page ping.
--
-- File: infra/db/migrations/032_visitor_lead_tracking.sql
-------------------------------------------------------------------------------

ALTER TABLE visitor_company_intent
  ADD COLUMN IF NOT EXISTS lead_created_at TIMESTAMPTZ;

COMMENT ON COLUMN visitor_company_intent.lead_created_at IS
  'Set once a corporate visitor crosses the 2+ visit / 24h frequency gate and a growth_opportunity lead has been created for it.';
