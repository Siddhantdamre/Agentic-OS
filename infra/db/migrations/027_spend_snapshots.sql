-- 027: record what the LLM provider says we have spent, over time.
--
-- WHY
-- The OpenRouter balance reached zero mid-run and 11 of 12 test conversations
-- got no reply. Nothing warned first. The failure surfaced as silence, which
-- is both the worst way to find out and the worst thing for a company
-- evaluating the product to watch.
--
-- WHY NOT USE LITELLM'S OWN SPEND NUMBERS
-- Because they are wrong here, and wrong in the direction that gets you hurt.
-- LiteLLM_SpendLogs for the last 7 days records $0.0032 total across 2,300
-- calls, while OpenRouter charged roughly $14 over the same period. LiteLLM
-- prices a call from its built-in model table, which does not have correct
-- entries for these OpenRouter routes, and correctly records $0.00 for the
-- :free tier — which served 40 million tokens in that window. A burn-rate
-- alarm built on that column would report "spending nothing" right up to the
-- moment everything stopped.
--
-- So the authority is the provider's own usage figure, sampled over time. Two
-- readings and the clock between them give a real burn rate; a burn rate and a
-- balance give runway in days, which is the only number an operator can act
-- on. LiteLLM stays useful for call and token VOLUME, which it counts
-- accurately — just not for money.

CREATE TABLE IF NOT EXISTS provider_spend_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT        NOT NULL,
  -- Cumulative, as the provider reports it. Deltas are computed on read, so a
  -- missed sample costs resolution and never corrupts the series.
  total_usage  NUMERIC(14, 6) NOT NULL,
  total_credits NUMERIC(14, 6),
  -- Volume from LiteLLM, which counts these accurately even though it prices
  -- them badly. Stored alongside so cost-per-call can be derived from the
  -- provider's money and LiteLLM's counts.
  calls        BIGINT,
  tokens       BIGINT,
  taken_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE provider_spend_snapshots IS
  'Periodic readings of provider-reported cumulative usage. The burn rate and '
  'runway in infra/scripts/spend-guard.js are derived from consecutive rows. '
  'Not tenant data: no org_id, no RLS — this is one row per provider per '
  'sample for the whole deployment.';

-- Reads are always "the newest few rows for one provider".
CREATE INDEX IF NOT EXISTS idx_provider_spend_snapshots_recent
  ON provider_spend_snapshots (provider, taken_at DESC);
