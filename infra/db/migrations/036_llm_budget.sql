-- 036: per-tenant LLM budget — stop one workspace starving the rest.
--
-- WHY
-- Every tenant on this deployment draws from one shared model pool. A single
-- runaway loop in one workspace consumes the free tier's daily allowance and
-- the paid balance for all 59 of them, and the first anyone knows is that
-- replies stop. That has already happened once here: the balance reached zero
-- and 11 of 12 conversations got no reply.
--
-- Until now this could not even be measured, let alone enforced: every call
-- was billed to the proxy's own key. Commits 4525f28, 41e48c1 and 85373dc
-- fixed attribution across all six worker call sites, which is what makes this
-- table possible.
--
-- ── THE LIMIT IS IN TOKENS, NOT MONEY ─────────────────────────────────────
-- Migration 027 records why LiteLLM's money column cannot be trusted for these
-- OpenRouter routes: it priced a window at $0.0032 that the provider charged
-- ~$14 for. Worse for this purpose, the :free tier is correctly $0.00 and has
-- served 46,034,270 tokens on this deployment — so a dollar-denominated budget
-- would let one tenant consume the entire free allowance for everybody and
-- still read "$0.00 of $50.00 used".
--
-- Tokens are the one per-tenant quantity LiteLLM counts accurately. So tokens
-- are what is stored, what is capped, and what enforcement reads. Money is
-- derived for display from provider_spend_snapshots and labelled an estimate.
--
-- ── WHAT IS DELIBERATELY NOT STORED HERE ──────────────────────────────────
-- No message text, no prompts, no completions, no contact details — only
-- org_id, a date, a model name and counts. Usage metering does not need
-- personal data, and a billing subsystem that quietly becomes a second copy of
-- every conversation is a liability under the DPDP Act's purpose-limitation
-- and minimisation duties. Anything needing conversation content reads the
-- conversation tables, under their own RLS and their own retention rules.

-- ── The limit ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_llm_budget (
  org_id              UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,

  -- NULL means unlimited, and that is the default state of the world: a
  -- workspace with no row here is unbudgeted. Shipping this feature therefore
  -- cannot silently throttle any of the 59 workspaces that already exist.
  -- Zero is a different thing entirely and is honoured as a real ceiling.
  monthly_token_limit BIGINT,

  -- degrade  keep answering on the free tier          (default)
  -- stop     refuse the turn                          (opt-in)
  --
  -- Default is degrade because the alternative is a self-inflicted version of
  -- the outage this table exists to prevent. A budget that produces silence
  -- has reproduced the failure, not prevented it.
  on_exceeded         TEXT NOT NULL DEFAULT 'degrade'
                      CHECK (on_exceeded IN ('degrade', 'stop')),

  warn_at             NUMERIC(3, 2) NOT NULL DEFAULT 0.80
                      CHECK (warn_at > 0 AND warn_at <= 1),

  -- Stamped when a notice goes out, so crossing the line tells the owner once
  -- per period instead of on every turn. The period is part of the value so a
  -- new month re-arms the notice without a separate reset job.
  warned_for_period   DATE,
  exceeded_for_period DATE,

  updated_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE org_llm_budget IS
  'Per-workspace token ceiling. NULL limit = unlimited (the default for any '
  'workspace with no row). Enforcement is in tokens, never in LiteLLM dollars '
  '— see migration 027 for why those are wrong on these routes.';

ALTER TABLE org_llm_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_llm_budget FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_llm_budget_org_isolation ON org_llm_budget;
CREATE POLICY org_llm_budget_org_isolation ON org_llm_budget
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── The meter ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_llm_usage_daily (
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  usage_date        DATE NOT NULL,
  -- Kept per model so "you are over budget" can be answered with "on what",
  -- and so free-tier volume is visible separately from paid volume.
  model             TEXT NOT NULL,

  calls             BIGINT NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens      BIGINT NOT NULL DEFAULT 0,
  -- A failed call still consumed a slot and, on OpenRouter, still counts
  -- against the free tier's daily cap. Counted, but never billed as tokens.
  failures          BIGINT NOT NULL DEFAULT 0,

  rolled_up_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, usage_date, model)
);

COMMENT ON TABLE org_llm_usage_daily IS
  'Rollup of LiteLLM_SpendLogs grouped by attributed tenant, day and model. '
  'Counts only — deliberately holds no prompts, completions or contact data.';

CREATE INDEX IF NOT EXISTS idx_org_llm_usage_daily_period
  ON org_llm_usage_daily (org_id, usage_date DESC);

ALTER TABLE org_llm_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_llm_usage_daily FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_llm_usage_daily_org_isolation ON org_llm_usage_daily;
CREATE POLICY org_llm_usage_daily_org_isolation ON org_llm_usage_daily
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── The door through the wall ───────────────────────────────────────────────
-- The rollup reads one source (the LiteLLM database) and writes rows for many
-- tenants. It cannot set a single org context, and FORCE ROW LEVEL SECURITY
-- applies to the table owner too, so it needs an explicit, narrow door rather
-- than a role that can see everything.
--
-- This function writes counts and nothing else. It cannot be used to read
-- another tenant's data, which is the property that makes a SECURITY DEFINER
-- acceptable here.
DROP FUNCTION IF EXISTS record_llm_usage(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT);
CREATE FUNCTION record_llm_usage(
  p_org_id     UUID,
  p_date       DATE,
  p_model      TEXT,
  p_calls      BIGINT,
  p_prompt     BIGINT,
  p_completion BIGINT,
  p_total      BIGINT,
  p_failures   BIGINT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Ignore a row for a workspace that no longer exists rather than failing the
  -- whole rollup: test tenants are deleted constantly, and one stale spend log
  -- must not stop every real tenant's meter from advancing.
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = p_org_id) THEN
    RETURN;
  END IF;

  INSERT INTO org_llm_usage_daily AS u (
    org_id, usage_date, model,
    calls, prompt_tokens, completion_tokens, total_tokens, failures, rolled_up_at
  ) VALUES (
    p_org_id, p_date, p_model,
    COALESCE(p_calls, 0), COALESCE(p_prompt, 0), COALESCE(p_completion, 0),
    COALESCE(p_total, 0), COALESCE(p_failures, 0), NOW()
  )
  ON CONFLICT (org_id, usage_date, model) DO UPDATE SET
    -- Assignment, not addition. The rollup recomputes a whole day from the
    -- source of truth, so re-running it must be idempotent; adding would
    -- double every figure on the second run and silently exhaust budgets.
    calls             = EXCLUDED.calls,
    prompt_tokens     = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens,
    total_tokens      = EXCLUDED.total_tokens,
    failures          = EXCLUDED.failures,
    rolled_up_at      = NOW()
  WHERE u.org_id = p_org_id;
END;
$$;

COMMENT ON FUNCTION record_llm_usage IS
  'Write-only door for the usage rollup. Upsert is assignment, not addition, '
  'so re-running a day is idempotent.';

-- ── What the gate reads ─────────────────────────────────────────────────────
-- One call, on the hot path of every agent turn, answering "what is the limit
-- and how much of it is gone". Returns the caller's own workspace only: the
-- p_org_id argument is checked against the session's org context, so this
-- cannot be used to read another tenant's consumption.
DROP FUNCTION IF EXISTS llm_budget_status(UUID);
CREATE FUNCTION llm_budget_status(p_org_id UUID)
RETURNS TABLE (
  limit_tokens  BIGINT,
  used_tokens   BIGINT,
  on_exceeded   TEXT,
  warn_at       NUMERIC,
  period_start  DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx   UUID := (NULLIF(current_setting('app.current_org_id', true), ''))::uuid;
  v_start DATE := date_trunc('month', NOW())::date;
BEGIN
  -- The whole point of a SECURITY DEFINER is that it bypasses RLS, so the
  -- check RLS would have done has to be made here explicitly. Without this
  -- line the function is a hole straight through tenant isolation.
  IF v_ctx IS NULL OR v_ctx <> p_org_id THEN
    RAISE EXCEPTION 'llm_budget_status: org context does not match requested org';
  END IF;

  RETURN QUERY
  SELECT
    b.monthly_token_limit,
    COALESCE((
      SELECT SUM(u.total_tokens)::bigint
        FROM org_llm_usage_daily u
       WHERE u.org_id = p_org_id
         AND u.usage_date >= v_start
    ), 0::bigint),
    COALESCE(b.on_exceeded, 'degrade'),
    COALESCE(b.warn_at, 0.80),
    v_start
  FROM (SELECT p_org_id AS id) o
  LEFT JOIN org_llm_budget b ON b.org_id = o.id;
END;
$$;

COMMENT ON FUNCTION llm_budget_status IS
  'Limit and month-to-date consumption for the CALLING workspace. Raises if '
  'the requested org is not the session org — a SECURITY DEFINER must repeat '
  'the check that RLS would have made.';

GRANT EXECUTE ON FUNCTION record_llm_usage(UUID, DATE, TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT) TO darex_app;
GRANT EXECUTE ON FUNCTION llm_budget_status(UUID) TO darex_app;
