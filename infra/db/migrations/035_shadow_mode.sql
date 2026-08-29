-- 035: shadow mode — let the agent prove itself before it is trusted.
--
-- WHY
-- Every objection to letting an AI act reduces to "I don't trust it". A demo
-- does not answer that. Neither does a resolution rate, which only shows the
-- agent handled the cases it was given.
--
-- What answers it is evidence about this business's own judgement:
--
--   "Over your last 50 decisions, the agent would have done the same thing 47
--    times. Here are the 3 it got wrong, and what you did instead."
--
-- Most of that is already collected. reply_edits holds the draft beside what
-- the operator actually sent; approval_requests holds what the agent wanted to
-- do beside what the human decided. This migration adds the switch that turns
-- ordinary operation into deliberate evidence-gathering — and, critically, the
-- record of WHEN it was on, so a rate can be honestly scoped to the period the
-- agent was actually being judged.
--
-- WHAT SHADOW MODE DOES
-- Nothing is sent. Every reply the agent would have sent becomes a decision
-- for a human: send it, or edit and send. Two weeks of that produces enough
-- evidence to have a real conversation about autonomy, instead of asking for
-- faith.
--
-- WHAT THIS NUMBER IS NOT
-- It is not accuracy. The human is not ground truth for what is CORRECT, only
-- for what this business would have done. An agent agreeing perfectly with a
-- mistaken operator is agreeing perfectly and performing badly. Every label in
-- the product says "agreed with you", never "was right", and that wording is
-- asserted in the unit tests so it survives contact with marketing.

CREATE TABLE IF NOT EXISTS org_shadow_mode (
  org_id      UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,

  -- off       normal operation; evidence still accrues from ordinary edits
  -- on        the agent drafts and NOTHING is sent without a person
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,

  -- When the current run started, so a rate can be scoped to "while you were
  -- watching". A number that silently mixes shadowed and unshadowed periods
  -- answers a question nobody asked.
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  enabled_by  UUID,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE org_shadow_mode IS
  'Per-org switch. While on, the agent proposes and never sends. started_at '
  'scopes the agreement rate to the period the agent was actually being '
  'judged.';

ALTER TABLE org_shadow_mode ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_shadow_mode FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_shadow_mode_org_isolation ON org_shadow_mode;
CREATE POLICY org_shadow_mode_org_isolation ON org_shadow_mode
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_shadow_mode TO darex_app;

/** Is the agent currently forbidden from sending? Defaults to no. */
CREATE OR REPLACE FUNCTION shadow_mode_enabled(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT enabled FROM org_shadow_mode WHERE org_id = p_org_id), FALSE);
$$;

/**
 * Turn it on or off, recording when.
 *
 * Turning it ON always restarts the clock. A business that shadowed for a week
 * in March, switched off, and switches on again in August is starting a new
 * observation — folding those together would produce a rate that describes
 * neither period.
 */
CREATE OR REPLACE FUNCTION set_shadow_mode(
  p_org_id  UUID,
  p_enabled BOOLEAN,
  p_user_id UUID DEFAULT NULL
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started TIMESTAMPTZ;
BEGIN
  INSERT INTO org_shadow_mode (org_id, enabled, started_at, ended_at, enabled_by)
  VALUES (p_org_id, p_enabled,
          CASE WHEN p_enabled THEN NOW() ELSE NULL END,
          CASE WHEN p_enabled THEN NULL ELSE NOW() END,
          p_user_id)
  ON CONFLICT (org_id) DO UPDATE
    SET enabled    = EXCLUDED.enabled,
        started_at = CASE WHEN EXCLUDED.enabled THEN NOW() ELSE org_shadow_mode.started_at END,
        ended_at   = CASE WHEN EXCLUDED.enabled THEN NULL ELSE NOW() END,
        enabled_by = EXCLUDED.enabled_by,
        updated_at = NOW()
  RETURNING started_at INTO v_started;
  RETURN v_started;
END;
$$;

REVOKE ALL ON FUNCTION set_shadow_mode(UUID, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_shadow_mode(UUID, BOOLEAN, UUID) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION shadow_mode_enabled(UUID) TO darex, darex_app;

-- The agreement query reads recent edits and decided approvals for one org.
CREATE INDEX IF NOT EXISTS idx_reply_edits_recent
  ON reply_edits (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_requests_decided
  ON approval_requests (org_id, decided_at DESC)
  WHERE status IN ('approved', 'rejected');
