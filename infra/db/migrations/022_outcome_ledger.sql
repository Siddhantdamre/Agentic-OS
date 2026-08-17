-------------------------------------------------------------------------------
-- Outcome Ledger — Migration 022
--
-- Answers the question every buyer actually asks: "is this thing working?"
--
-- DESIGN PRINCIPLE: never overclaim. The ledger keeps three ideas strictly
-- separate, because collapsing them is how analytics products lose trust:
--
--   1. agent_actions   — what the agent DID.        (fact)
--   2. outcome_events  — what HAPPENED afterwards.  (fact)
--   3. action_outcomes — our CLAIM that (2) relates to (1), tagged with the
--                        method used and how strong that method is. (inference)
--
-- A row in action_outcomes is explicitly NOT a causal claim. Causation is only
-- supportable where a holdout arm exists (agent_actions.arm = 'holdout'),
-- letting treatment and control be compared on the same outcome definition.
-- The `outcome_lift` view does exactly that and nothing more.
--
-- Everything is auditable: every action and outcome carries
-- (source_table, source_id) pointing at the row it was derived from, so any
-- number shown to a customer can be walked back to raw evidence.
--
-- File: infra/db/migrations/022_outcome_ledger.sql
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- 1. AGENT_ACTIONS — normalized ledger of things the agent did.
--
--    Materialized from messages / channel_logs rather than queried live, so
--    attribution is stable: re-running the attributor must not silently change
--    yesterday's numbers because an upstream row was edited.
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_actions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,
  employee_id       UUID REFERENCES ai_employees(id) ON DELETE SET NULL,

  action_kind       TEXT NOT NULL,

  -- Provenance. Every action must be walkable back to the row it came from;
  -- this is what makes a customer-facing number defensible under scrutiny.
  source_table      TEXT NOT NULL,
  source_id         TEXT NOT NULL,

  occurred_at       TIMESTAMPTZ NOT NULL,

  -- Experiment arm. 'treatment' = the agent acted. 'holdout' = deliberately
  -- withheld (or handled by a human) so a control exists. Without holdouts the
  -- ledger can report correlation only — see the outcome_lift view.
  arm               TEXT NOT NULL DEFAULT 'treatment',
  experiment_key    TEXT,

  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: the attributor is expected to re-run over overlapping windows
  -- (Temporal retries, backfills). Re-ingesting the same source row must be a
  -- no-op, not a duplicate that inflates every downstream count.
  CONSTRAINT agent_actions_source_uq UNIQUE (org_id, source_table, source_id, action_kind),
  CONSTRAINT agent_actions_arm_chk CHECK (arm IN ('treatment', 'holdout')),
  CONSTRAINT agent_actions_kind_chk CHECK (action_kind IN (
    'reply_sent',        -- assistant message delivered to a customer
    'tool_executed',     -- a connector/tool call ran
    'plan_executed',     -- a confirmed multi-step plan ran
    'escalated',         -- handed to a human
    'no_action'          -- holdout arm: agent deliberately did not act
  )),
  CONSTRAINT agent_actions_source_id_chk CHECK (btrim(source_id) <> '')
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_org_time
  ON agent_actions (org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_actions_org_conv
  ON agent_actions (org_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_org_arm
  ON agent_actions (org_id, arm, action_kind);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_actions_org_isolation ON agent_actions;
CREATE POLICY agent_actions_org_isolation ON agent_actions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_actions TO darex_app;

-------------------------------------------------------------------------------
-- 2. OUTCOME_EVENTS — observed business outcomes. Facts only, no interpretation.
--
--    An outcome row asserts "this happened at this time", never "the agent
--    caused it". Kept separate from agent_actions so the same outcome can be
--    considered by several attribution methods without being double-counted.
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,

  outcome_kind      TEXT NOT NULL,

  -- Optional magnitude (deal value, minutes saved). NULL when the outcome is
  -- purely binary — deliberately nullable rather than defaulting to 0, which
  -- would silently drag any AVG() toward zero.
  value_numeric     NUMERIC,
  value_currency    TEXT,

  occurred_at       TIMESTAMPTZ NOT NULL,

  source_table      TEXT NOT NULL,
  source_id         TEXT NOT NULL,

  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT outcome_events_source_uq UNIQUE (org_id, source_table, source_id, outcome_kind),
  CONSTRAINT outcome_events_kind_chk CHECK (outcome_kind IN (
    'customer_replied',      -- the customer responded
    'conversation_resolved', -- thread closed out
    'human_took_over',       -- a person had to step in (a NEGATIVE outcome)
    'human_approved',        -- a person confirmed a proposed plan
    'human_rejected',        -- a person rejected it (NEGATIVE)
    'feedback_positive',     -- explicit thumbs up
    'feedback_negative',     -- explicit thumbs down (NEGATIVE)
    'meeting_booked',
    'payment_received',
    'deal_closed'
  )),
  CONSTRAINT outcome_events_currency_chk CHECK (
    value_currency IS NULL OR btrim(value_currency) <> ''
  ),
  CONSTRAINT outcome_events_source_id_chk CHECK (btrim(source_id) <> '')
);

CREATE INDEX IF NOT EXISTS idx_outcome_events_org_time
  ON outcome_events (org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcome_events_org_conv
  ON outcome_events (org_id, conversation_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outcome_events_org_kind
  ON outcome_events (org_id, outcome_kind, occurred_at DESC);

ALTER TABLE outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outcome_events_org_isolation ON outcome_events;
CREATE POLICY outcome_events_org_isolation ON outcome_events
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON outcome_events TO darex_app;

-------------------------------------------------------------------------------
-- 3. ACTION_OUTCOMES — the attribution edge. THIS IS AN INFERENCE, NOT A FACT.
--
--    `method` records HOW the link was made and `strength` how much weight it
--    deserves. They are stored, not derived at read time, so a later change to
--    attribution rules cannot silently rewrite history — old rows keep the
--    method that actually produced them.
--
--      direct_reply       (strong)   — customer's very next message in-thread
--      same_conversation  (moderate) — same thread, inside the window, but
--                                      other actions also intervened
--      temporal_proximity (weak)     — org-level correlation only, no thread
--                                      link. Reportable, never headline-worthy.
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action_outcomes (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  action_id         UUID NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
  outcome_id        UUID NOT NULL REFERENCES outcome_events(id) ON DELETE CASCADE,

  method            TEXT NOT NULL,
  strength          TEXT NOT NULL,

  -- How long after the action the outcome landed, and the window the attributor
  -- was allowed to consider. Storing the window makes results reproducible:
  -- "computed under a 24h window" is a materially different claim from 7 days.
  latency_seconds   INTEGER NOT NULL,
  window_seconds    INTEGER NOT NULL,

  -- Row ids / counts justifying this edge. What lets support answer
  -- "why does the dashboard say that?" without re-deriving anything.
  evidence          JSONB NOT NULL DEFAULT '{}',

  attributed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT action_outcomes_pair_uq UNIQUE (action_id, outcome_id),
  CONSTRAINT action_outcomes_method_chk CHECK (method IN (
    'direct_reply', 'same_conversation', 'temporal_proximity'
  )),
  CONSTRAINT action_outcomes_strength_chk CHECK (strength IN ('strong', 'moderate', 'weak')),
  CONSTRAINT action_outcomes_latency_chk CHECK (latency_seconds >= 0),
  CONSTRAINT action_outcomes_window_chk CHECK (window_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_action_outcomes_org_action
  ON action_outcomes (org_id, action_id);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_org_outcome
  ON action_outcomes (org_id, outcome_id);
CREATE INDEX IF NOT EXISTS idx_action_outcomes_org_method
  ON action_outcomes (org_id, method, strength);

ALTER TABLE action_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_outcomes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS action_outcomes_org_isolation ON action_outcomes;
CREATE POLICY action_outcomes_org_isolation ON action_outcomes
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON action_outcomes TO darex_app;

-------------------------------------------------------------------------------
-- 4. OUTCOME_LIFT — treatment vs holdout, the only causal-ish claim available.
--
--    Rate is computed over ACTIONS, not over attributed pairs, so actions that
--    produced nothing stay in the denominator. Omitting them is the single most
--    common way dashboards flatter themselves.
--
--    `lift_pp` is in percentage POINTS (treatment_rate - holdout_rate). When
--    there is no holdout, holdout_actions = 0 and lift_pp is NULL — the honest
--    answer, rather than a fabricated baseline.
-------------------------------------------------------------------------------
CREATE OR REPLACE VIEW outcome_lift AS
WITH per_arm AS (
  SELECT
    a.org_id,
    a.action_kind,
    a.experiment_key,
    o.outcome_kind,
    a.arm,
    COUNT(DISTINCT a.id) AS actions,
    COUNT(DISTINCT a.id) FILTER (WHERE ao.id IS NOT NULL) AS actions_with_outcome
  FROM agent_actions a
  LEFT JOIN action_outcomes ao
         ON ao.action_id = a.id AND ao.org_id = a.org_id
  LEFT JOIN outcome_events o
         ON o.id = ao.outcome_id AND o.org_id = a.org_id
  GROUP BY a.org_id, a.action_kind, a.experiment_key, o.outcome_kind, a.arm
)
SELECT
  org_id,
  action_kind,
  experiment_key,
  outcome_kind,
  SUM(actions) FILTER (WHERE arm = 'treatment')             AS treatment_actions,
  SUM(actions_with_outcome) FILTER (WHERE arm = 'treatment') AS treatment_hits,
  SUM(actions) FILTER (WHERE arm = 'holdout')                AS holdout_actions,
  SUM(actions_with_outcome) FILTER (WHERE arm = 'holdout')   AS holdout_hits,
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'treatment'), 0) > 0
       THEN ROUND(100.0 * SUM(actions_with_outcome) FILTER (WHERE arm = 'treatment')
                        / SUM(actions) FILTER (WHERE arm = 'treatment'), 2)
  END AS treatment_rate_pct,
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'holdout'), 0) > 0
       THEN ROUND(100.0 * SUM(actions_with_outcome) FILTER (WHERE arm = 'holdout')
                        / SUM(actions) FILTER (WHERE arm = 'holdout'), 2)
  END AS holdout_rate_pct,
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'holdout'), 0) > 0
        AND COALESCE(SUM(actions) FILTER (WHERE arm = 'treatment'), 0) > 0
       THEN ROUND(
              100.0 * SUM(actions_with_outcome) FILTER (WHERE arm = 'treatment')
                    / SUM(actions) FILTER (WHERE arm = 'treatment')
            - 100.0 * SUM(actions_with_outcome) FILTER (WHERE arm = 'holdout')
                    / SUM(actions) FILTER (WHERE arm = 'holdout'), 2)
  END AS lift_pp
FROM per_arm
GROUP BY org_id, action_kind, experiment_key, outcome_kind;

GRANT SELECT ON outcome_lift TO darex_app;

-------------------------------------------------------------------------------
-- Comments — these ship to anyone reading the schema, so they carry the
-- warnings that keep the numbers honest.
-------------------------------------------------------------------------------
COMMENT ON TABLE agent_actions IS
  'What the agent did. Materialized from messages/channel_logs with (source_table, source_id) provenance and a UNIQUE key so re-runs are idempotent.';
COMMENT ON COLUMN agent_actions.arm IS
  'treatment = agent acted; holdout = deliberately withheld as a control. Causal claims require holdouts; without them the ledger reports correlation only.';
COMMENT ON TABLE outcome_events IS
  'Observed business outcomes. Facts with timestamps — asserts nothing about what caused them.';
COMMENT ON COLUMN outcome_events.value_numeric IS
  'Optional magnitude. Deliberately NULL (not 0) when not applicable, so averages are not dragged toward zero.';
COMMENT ON TABLE action_outcomes IS
  'INFERENCE, not fact: a claim that an outcome relates to an action. Always read with method + strength; direct_reply is defensible, temporal_proximity is not.';
COMMENT ON COLUMN action_outcomes.window_seconds IS
  'Attribution window used. Stored because the same data under a different window is a different claim; required for reproducibility.';
COMMENT ON VIEW outcome_lift IS
  'Treatment vs holdout comparison. lift_pp is in percentage points and is NULL when no holdout exists — the honest answer instead of an invented baseline.';
