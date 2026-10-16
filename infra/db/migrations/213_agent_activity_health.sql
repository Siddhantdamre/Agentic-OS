-- 213: a heartbeat for background work.
--
-- WHAT WAS MISSING
-- Nothing recorded whether an AI employee's background checks (sweeps, follow-ups, reminders) were still running.
-- The old sweep counters were never incremented, so a sweep that died looked the same as a quiet one.
--
-- WHAT THIS ADDS
--   agent_activity_health   one row per workspace and activity: when it last finished, when it last failed and the
--                           short error text, and running counts. The worker writes it (see activity-health.ts);
--                           the Health page reads it.
--
-- Tenant table: row-level security forced, same org policy as every other tenant table. The error text is cleaned of
-- e-mail addresses and long numbers before it is stored. darex_sql_reader gets no access.

CREATE TABLE IF NOT EXISTS agent_activity_health (
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  activity      TEXT NOT NULL,
  last_ok_at    TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error    TEXT,
  ok_count      BIGINT NOT NULL DEFAULT 0,
  fail_count    BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, activity)
);

ALTER TABLE agent_activity_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_activity_health FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_activity_health_org_isolation ON agent_activity_health;
CREATE POLICY agent_activity_health_org_isolation ON agent_activity_health
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_activity_health TO darex_app;

-- Model-written SQL may read it, so the assistant can answer "are my background checks running?". It holds no
-- customer detail: activity names, timestamps, counts and error text cleaned of e-mail addresses and long numbers.
GRANT SELECT ON agent_activity_health TO darex_sql_reader;
