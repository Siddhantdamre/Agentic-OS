-- 211: the evidence "earned autonomy" rests on.
--
-- WHAT WAS WRONG
-- PATCH /api/org/rollout asked the browser for the evidence (weeks in stage,
-- divergences, approval rate, decisions) and checked it against the exit rules, so
-- any manager could "earn" a stage by typing numbers, and `force` skipped the check
-- altogether. The first stage's evidence, shadow_reviewed and shadow_agreed on
-- org_runtime_controls, is never written by anything: leaving watching mode was
-- only possible by forcing it. Nothing recorded a stage change or who made it.
--
-- WHAT THIS ADDS
--   agent_shadow_reviews        one row per "would you have done this?" answer an
--                               operator gives about a watching-mode decision. The
--                               counts the exit rule needs are counted from here,
--                               so they cannot be typed in. One answer per
--                               decision (a person may change their mind).
--   org_autonomy_stage_events   one row per stage change: who, when, from and to,
--                               why, and the measured evidence at that moment. This
--                               is also how "weeks in this stage" is known.
--
-- Both are tenant tables: row-level security forced, org policy in the same
-- hardened form as every other tenant table. Both hold only booleans, stage numbers
-- and measured counts (no credential), so darex_sql_reader may SELECT them like the
-- other tenant tables; its row-level security still limits it to one workspace.
-- Stage events are insert-only for the application role apart from the DELETE a
-- data-erasure request needs.

CREATE TABLE IF NOT EXISTS agent_shadow_reviews (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ledger_id    UUID NOT NULL REFERENCES agent_decision_ledger(id) ON DELETE CASCADE,
  agreed       BOOLEAN NOT NULL,
  reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_agent_shadow_reviews_ledger UNIQUE (ledger_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_shadow_reviews_org
  ON agent_shadow_reviews (org_id, reviewed_at DESC);

ALTER TABLE agent_shadow_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_shadow_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_shadow_reviews_org_isolation ON agent_shadow_reviews;
CREATE POLICY agent_shadow_reviews_org_isolation ON agent_shadow_reviews
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_shadow_reviews TO darex_app;
GRANT SELECT ON agent_shadow_reviews TO darex_sql_reader;

CREATE TABLE IF NOT EXISTS org_autonomy_stage_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  from_stage     INTEGER NOT NULL,
  to_stage       INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  reason         TEXT,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_autonomy_stage_events_stage_chk CHECK (from_stage BETWEEN 0 AND 3 AND to_stage BETWEEN 0 AND 3),
  CONSTRAINT org_autonomy_stage_events_kind_chk CHECK (kind IN ('advance', 'override', 'pull_back', 'pause'))
);

CREATE INDEX IF NOT EXISTS idx_org_autonomy_stage_events_org
  ON org_autonomy_stage_events (org_id, created_at DESC);

ALTER TABLE org_autonomy_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_autonomy_stage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_autonomy_stage_events_org_isolation ON org_autonomy_stage_events;
CREATE POLICY org_autonomy_stage_events_org_isolation ON org_autonomy_stage_events
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);
GRANT SELECT, INSERT, DELETE ON org_autonomy_stage_events TO darex_app;
GRANT SELECT ON org_autonomy_stage_events TO darex_sql_reader;

COMMENT ON TABLE agent_shadow_reviews IS
  'An operator''s answer to "would you have done this?" for one watching-mode decision. Counted for the first stage exit.';
COMMENT ON TABLE org_autonomy_stage_events IS
  'Every autonomy stage change with the measured evidence at that moment. kind override = moved up without meeting the exit rules.';
