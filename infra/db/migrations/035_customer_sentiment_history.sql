-------------------------------------------------------------------------------
-- Angry Customer Radar — multi-turn sentiment history — Migration 035
--
-- CE-09 previously only looked at the current message's keywords. This adds
-- a durable per-turn sentiment log so the radar can detect a *trend*
-- (e.g. 2 of the last 3 turns going negative) instead of reacting to, or
-- missing, a single message in isolation.
--
-- File: infra/db/migrations/035_customer_sentiment_history.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS agent_sentiment_history (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL,
  customer_identifier TEXT,
  state               TEXT NOT NULL,
  severity            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_sentiment_history_conv
  ON agent_sentiment_history (org_id, conversation_id, created_at DESC);

ALTER TABLE agent_sentiment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sentiment_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_sentiment_history_org_isolation ON agent_sentiment_history;
CREATE POLICY agent_sentiment_history_org_isolation ON agent_sentiment_history
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sentiment_history TO darex_app;

COMMENT ON TABLE agent_sentiment_history IS
  'CE-09 Angry Customer Radar — one row per turn''s inferred operational state, so a negative trend across turns can be detected instead of a single-message keyword hit.';
