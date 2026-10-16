-------------------------------------------------------------------------------
-- Smart Reply Sorter ledger — Migration 034
--
-- GE-09 needs to remember which inbound Gmail messages have already been
-- classified so the poller never re-alerts the rep or re-updates the CRM
-- stage twice for the same reply.
--
-- File: infra/db/migrations/034_growth_reply_classifications.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS growth_reply_classifications (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  from_email      TEXT NOT NULL DEFAULT '',
  work_item_id    UUID REFERENCES work_items(id) ON DELETE SET NULL,
  classification  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT growth_reply_classifications_kind_chk CHECK (
    classification IN ('interested', 'objection', 'ooo', 'unsubscribe', 'neutral')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_reply_classifications_org_msg
  ON growth_reply_classifications (org_id, gmail_message_id);

ALTER TABLE growth_reply_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_reply_classifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS growth_reply_classifications_org_isolation ON growth_reply_classifications;
CREATE POLICY growth_reply_classifications_org_isolation ON growth_reply_classifications
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_reply_classifications TO darex_app;

COMMENT ON TABLE growth_reply_classifications IS
  'GE-09 Smart Reply Sorter — one row per Gmail reply already classified, so CRM stage updates and rep alerts fire exactly once.';
