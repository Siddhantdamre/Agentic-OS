-------------------------------------------------------------------------------
-- Pre-Meeting Account Dossier ledger — Migration 033
--
-- GE-07 needs a durable record of which upcoming Google Calendar meetings
-- already got a dossier compiled and posted to Slack, so the poller never
-- re-posts the same brief on every sweep.
--
-- File: infra/db/migrations/033_growth_meeting_dossiers.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS growth_meeting_dossiers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  calendar_event_id TEXT NOT NULL,
  attendee_email    TEXT NOT NULL DEFAULT '',
  company_domain    TEXT NOT NULL DEFAULT '',
  posted_to_slack   BOOLEAN NOT NULL DEFAULT FALSE,
  dossier           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_meeting_dossiers_org_event
  ON growth_meeting_dossiers (org_id, calendar_event_id);

ALTER TABLE growth_meeting_dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_meeting_dossiers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_meeting_dossiers_org_isolation ON growth_meeting_dossiers;
CREATE POLICY growth_meeting_dossiers_org_isolation ON growth_meeting_dossiers
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_meeting_dossiers TO darex_app;

COMMENT ON TABLE growth_meeting_dossiers IS
  'GE-07 Pre-Meeting Account Dossier — one row per calendar event a dossier was already compiled/posted for.';
