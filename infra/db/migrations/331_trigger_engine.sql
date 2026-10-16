-- 031: the ignition. Give the declared triggers something that actually fires them.
--
-- WHY
-- services/workflows/src/workflows/ holds seventeen workflows, and most of them
-- are operator-shaped rather than chat-shaped: StaleChase, OwnerBriefing,
-- Nurture, RentReminder, ShowingSchedule, PlanExecute, Crew, MarketResearch.
-- The pack manifests even declare WHEN each should run:
--
--   OwnerBriefingWorkflow   triggers: ['daily']
--   StaleChaseWorkflow      triggers: ['scheduled']
--   RentReminderWorkflow    triggers: ['pm.charge.due']
--   ShowingScheduleWorkflow triggers: ['inquiry.book_showing']
--
-- Nothing anywhere dispatched them. Every one of the eight live entry points
-- into the agent is an inbound webhook or a human pressing a button, so the
-- system is blind between messages: it cannot notice a quote nobody answered,
-- an invoice going late, or a customer who went quiet. The vocabulary was a
-- schema with no engine behind it.
--
-- This migration supplies the two pieces of state an engine needs: a switch,
-- and a memory of what it has already done.
--
-- DEFAULT OFF, AND NOT AS A COURTESY
-- Reliability x20 has never completed cleanly and the latency targets are
-- unmet. A system that answers when spoken to can carry that; a system that
-- ACTS UNATTENDED cannot, because nobody is watching when it goes wrong.
-- Autonomy therefore requires an explicit, per-org, per-trigger decision that
-- somebody made on purpose. Installing a pack must never start anything: a
-- pack says what an org COULD automate, never what it has agreed to.

-- ── The switch ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_automation (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- 'daily', 'scheduled', 'pm.charge.due' — the vocabulary the manifests use.
  trigger_key  TEXT NOT NULL,

  -- off      nothing happens. The absence of a row means this too.
  -- dry_run  evaluate and RECORD what would have fired, start nothing. This is
  --          how an operator sees what the agent would do for a week before
  --          letting it do anything, and it is the only honest way to earn
  --          that permission.
  -- on       dispatch for real.
  mode         TEXT NOT NULL DEFAULT 'off'
               CHECK (mode IN ('off', 'dry_run', 'on')),

  -- Trigger-specific settings: hour of day, SLA hours, time zone, per-run cap.
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Who turned this on. An unattended action must always trace back to a
  -- person who authorised the class of action, even when no person authorised
  -- the individual one.
  enabled_by   UUID,
  enabled_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT org_automation_unique UNIQUE (org_id, trigger_key)
);

COMMENT ON TABLE org_automation IS
  'Per-org, per-trigger autonomy switch. No row means off. Installing a pack '
  'never writes here: a pack declares what an org COULD automate, never what '
  'it has agreed to.';

CREATE INDEX IF NOT EXISTS idx_org_automation_live
  ON org_automation (trigger_key, org_id) WHERE mode <> 'off';

ALTER TABLE org_automation ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_automation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_automation_org_isolation ON org_automation;
CREATE POLICY org_automation_org_isolation ON org_automation
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON org_automation TO darex_app;

-- ── The memory ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trigger_dispatches (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  trigger_key   TEXT NOT NULL,
  workflow_name TEXT NOT NULL,

  -- THE IDEMPOTENCY KEY, and the reason this table exists.
  --
  -- "the daily briefing fires once a day" has to be a database constraint, not
  -- a hope about how often a cron runs. The engine runs on the hourly alerting
  -- cadence, so without this a daily briefing would go out twenty-four times.
  --
  -- Its shape is per trigger: 'daily:2026-08-28' for a date, 'bucket:490231'
  -- for an interval, or the row id for a condition trigger, so one overdue
  -- charge produces exactly one reminder however often the engine runs.
  fire_key      TEXT NOT NULL,

  -- dispatched  a workflow was started
  -- dry_run     it WOULD have started; nothing ran
  -- skipped     a precondition failed (recorded, because a trigger that
  --             silently does nothing is indistinguishable from one that is
  --             broken — which is how the whole trigger vocabulary came to
  --             sit unused)
  -- failed      dispatch was attempted and errored
  status        TEXT NOT NULL
                CHECK (status IN ('dispatched', 'dry_run', 'skipped', 'failed')),

  workflow_id   TEXT,
  detail        TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Two engine runs racing, or an hourly run overlapping a manual one, must
  -- not double-fire. The database decides, not the scheduler.
  CONSTRAINT trigger_dispatches_once UNIQUE (org_id, trigger_key, fire_key)
);

COMMENT ON TABLE trigger_dispatches IS
  'Every trigger evaluation, fired or not. UNIQUE(org_id, trigger_key, '
  'fire_key) makes "once per day" / "once per charge" a constraint rather '
  'than a property of how often the scheduler happens to run.';

CREATE INDEX IF NOT EXISTS idx_trigger_dispatches_recent
  ON trigger_dispatches (org_id, dispatched_at DESC);

ALTER TABLE trigger_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_dispatches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trigger_dispatches_org_isolation ON trigger_dispatches;
CREATE POLICY trigger_dispatches_org_isolation ON trigger_dispatches
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON trigger_dispatches TO darex_app;

-- ── Claiming a fire ────────────────────────────────────────────────────────
/**
 * Reserve the right to fire, atomically.
 *
 * Returns TRUE exactly once for a given (org, trigger, fire_key). The insert
 * IS the lock: a second caller — a concurrent run, an overlapping cron, a
 * retry — conflicts and gets FALSE, so the caller never has to reason about
 * whether it raced. Claim first, dispatch second: a workflow started before
 * the claim would be lost on a crash between the two, and one started after a
 * failed claim would be a duplicate.
 */
CREATE OR REPLACE FUNCTION claim_trigger_fire(
  p_org_id      UUID,
  p_trigger_key TEXT,
  p_fire_key    TEXT,
  p_workflow    TEXT,
  p_status      TEXT DEFAULT 'dispatched',
  p_payload     JSONB DEFAULT '{}'::jsonb
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted INT;
BEGIN
  INSERT INTO trigger_dispatches
    (org_id, trigger_key, workflow_name, fire_key, status, payload)
  VALUES
    (p_org_id, p_trigger_key, p_workflow, p_fire_key, p_status, p_payload)
  ON CONFLICT (org_id, trigger_key, fire_key) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END;
$$;

REVOKE ALL ON FUNCTION claim_trigger_fire(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_trigger_fire(UUID, TEXT, TEXT, TEXT, TEXT, JSONB) TO darex, darex_app;

/** Record the outcome once dispatch has actually been attempted. */
CREATE OR REPLACE FUNCTION settle_trigger_fire(
  p_org_id      UUID,
  p_trigger_key TEXT,
  p_fire_key    TEXT,
  p_status      TEXT,
  p_workflow_id TEXT DEFAULT NULL,
  p_detail      TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE trigger_dispatches
     SET status = p_status,
         workflow_id = COALESCE(p_workflow_id, workflow_id),
         detail = COALESCE(p_detail, detail)
   WHERE org_id = p_org_id
     AND trigger_key = p_trigger_key
     AND fire_key = p_fire_key;
$$;

REVOKE ALL ON FUNCTION settle_trigger_fire(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_trigger_fire(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO darex, darex_app;
