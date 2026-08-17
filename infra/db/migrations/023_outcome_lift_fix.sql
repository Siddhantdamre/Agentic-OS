-------------------------------------------------------------------------------
-- Outcome lift — denominator fix. Migration 023.
--
-- THE BUG (introduced in 022, caught by an end-to-end assertion)
-- The view grouped actions and outcomes together, so an action only entered the
-- denominator for an outcome kind IF IT PRODUCED THAT OUTCOME. Every rate was
-- therefore ~100%, and actions that achieved nothing fell into a separate
-- NULL-outcome row instead of counting against the rate.
--
--   4 replies sent, 1 got a customer response.
--   Truth: 25%.   Reported by 022: 100%.
--
-- That is precisely the flattery 022's own comments claimed to prevent, and it
-- would have been the first number a buyer challenged.
--
-- THE FIX
-- Compute the denominator (all actions per kind/arm) SEPARATELY from the hits
-- (actions that produced a given outcome kind), then join. An action that
-- produced nothing now correctly drags every rate down, which is the entire
-- point of measuring.
--
-- Replaced rather than edited in place: 022 has already been applied to real
-- databases, and migrate.js tracks by filename — editing it would silently skip
-- the fix on any database that already ran it.
--
-- File: infra/db/migrations/023_outcome_lift_fix.sql
-------------------------------------------------------------------------------

DROP VIEW IF EXISTS outcome_lift;

CREATE VIEW outcome_lift AS
WITH
-- Denominator: EVERY action, whether or not it achieved anything.
universe AS (
  SELECT
    org_id,
    action_kind,
    experiment_key,
    arm,
    COUNT(*)::bigint AS actions
  FROM agent_actions
  GROUP BY org_id, action_kind, experiment_key, arm
),
-- Numerator: actions that produced a given outcome kind.
-- COUNT(DISTINCT) because one action may attribute to several outcomes of the
-- same kind; it must still count once.
hits AS (
  SELECT
    a.org_id,
    a.action_kind,
    a.experiment_key,
    a.arm,
    o.outcome_kind,
    COUNT(DISTINCT a.id)::bigint AS hits
  FROM agent_actions a
  JOIN action_outcomes ao ON ao.action_id = a.id  AND ao.org_id = a.org_id
  JOIN outcome_events  o  ON o.id = ao.outcome_id AND o.org_id = a.org_id
  GROUP BY a.org_id, a.action_kind, a.experiment_key, a.arm, o.outcome_kind
),
-- Only outcome kinds actually observed. Never invent rows for outcomes that
-- have not happened — an unmeasured outcome must be absent, not reported as 0%.
pairs AS (
  SELECT DISTINCT org_id, action_kind, experiment_key, outcome_kind FROM hits
),
-- Pair every observed (action_kind, outcome_kind) with the FULL action count
-- for each arm. `IS NOT DISTINCT FROM` because experiment_key is nullable and
-- `= NULL` would drop every unkeyed row.
grid AS (
  SELECT
    p.org_id,
    p.action_kind,
    p.experiment_key,
    p.outcome_kind,
    u.arm,
    u.actions,
    COALESCE(h.hits, 0) AS hits
  FROM pairs p
  JOIN universe u
    ON  u.org_id         = p.org_id
    AND u.action_kind    = p.action_kind
    AND u.experiment_key IS NOT DISTINCT FROM p.experiment_key
  LEFT JOIN hits h
    ON  h.org_id         = p.org_id
    AND h.action_kind    = p.action_kind
    AND h.experiment_key IS NOT DISTINCT FROM p.experiment_key
    AND h.outcome_kind   = p.outcome_kind
    AND h.arm            = u.arm
)
SELECT
  org_id,
  action_kind,
  experiment_key,
  outcome_kind,
  COALESCE(SUM(actions) FILTER (WHERE arm = 'treatment'), 0) AS treatment_actions,
  COALESCE(SUM(hits)    FILTER (WHERE arm = 'treatment'), 0) AS treatment_hits,
  COALESCE(SUM(actions) FILTER (WHERE arm = 'holdout'),   0) AS holdout_actions,
  COALESCE(SUM(hits)    FILTER (WHERE arm = 'holdout'),   0) AS holdout_hits,
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'treatment'), 0) > 0
       THEN ROUND(100.0 * SUM(hits)    FILTER (WHERE arm = 'treatment')
                        / SUM(actions) FILTER (WHERE arm = 'treatment'), 2)
  END AS treatment_rate_pct,
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'holdout'), 0) > 0
       THEN ROUND(100.0 * SUM(hits)    FILTER (WHERE arm = 'holdout')
                        / SUM(actions) FILTER (WHERE arm = 'holdout'), 2)
  END AS holdout_rate_pct,
  -- NULL, never 0, when there is no control group. "Not measured" and
  -- "measured as no effect" are entirely different claims to a buyer.
  CASE WHEN COALESCE(SUM(actions) FILTER (WHERE arm = 'holdout'), 0) > 0
        AND COALESCE(SUM(actions) FILTER (WHERE arm = 'treatment'), 0) > 0
       THEN ROUND(
              100.0 * SUM(hits)    FILTER (WHERE arm = 'treatment')
                    / SUM(actions) FILTER (WHERE arm = 'treatment')
            - 100.0 * SUM(hits)    FILTER (WHERE arm = 'holdout')
                    / SUM(actions) FILTER (WHERE arm = 'holdout'), 2)
  END AS lift_pp
FROM grid
GROUP BY org_id, action_kind, experiment_key, outcome_kind;

GRANT SELECT ON outcome_lift TO darex_app;

COMMENT ON VIEW outcome_lift IS
  'Treatment vs holdout. Rates are over ALL actions of that kind — actions that produced nothing stay in the denominator (fixed in 023; 022 divided by attributed actions only and always reported ~100%). lift_pp is NULL when no holdout exists.';
