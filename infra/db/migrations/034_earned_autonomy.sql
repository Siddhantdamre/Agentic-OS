-- 034: let the agent EARN the right to act, one action class at a time.
--
-- WHY
-- Two facts, measured on this database:
--
--   work_items status = 'waiting_approval'    24
--   work_events kind  = 'confirm_requested'   24
--   work_events kind  = 'confirm_approved'     0
--
-- The oldest has been waiting since 15 August. The agent asked twenty-four
-- times and was never once answered, because nothing in the dashboard can send
-- the approveWorkItem signal — the workflow defines it, handles it, and no
-- caller exists. Every consequential action the agent could take sits behind a
-- door with no handle.
--
-- That is a dead loop, and it is the one that caps what this product can ever
-- become: an assistant that must ask permission for everything, from someone
-- with no way to grant it, cannot grow into an operator.
--
-- THE ARCHITECTURAL PROBLEM UNDERNEATH
-- WorkItemWorkflow waits on a Temporal signal for HITL_WAIT_TIMEOUT, which is
-- two minutes. Humans do not answer in two minutes. Those 24 items timed out
-- thirteen days ago, so signalling them now does nothing at all.
--
-- So the DECISION has to be durable outside the workflow. The API records it
-- here first and signals Temporal second, best-effort. A decision made an hour
-- later is still a real decision — it just cannot un-time-out a workflow, and
-- the record is what lets the work be re-driven rather than lost.
--
-- EARNING TRUST
-- Once approvals can be answered, they accumulate into evidence. An action
-- class the operator has approved many times in a row, never rejected, does
-- not need to keep asking. That is the mechanism by which this gradually does
-- more without anyone flipping a switch marked "trust it" — and it is built
-- from THIS org's own approval history, which is why no competitor can ship
-- it pre-loaded.

-- ── What was asked, and what was decided ───────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_requests (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  work_item_id   UUID,
  conversation_id UUID,

  -- send | pay | sign | publish | price | legal | pack_banned
  action_class   TEXT NOT NULL,
  -- What the agent wanted to do, in words an operator can judge without
  -- opening anything else. An approval screen that says "approve action?" is
  -- one people click through without reading, which is worse than no gate.
  summary        TEXT NOT NULL DEFAULT '',
  draft          TEXT NOT NULL DEFAULT '',

  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'auto_approved')),
  decided_by     UUID,
  decided_at     TIMESTAMPTZ,
  -- Why it was rejected. This is the highest-value text in the table: it says
  -- what the agent got wrong in a case a human cared enough to stop.
  reason         TEXT,

  temporal_workflow_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One request per work item per class. A Temporal retry replaying the turn
  -- must not queue the same decision twice for a human to answer.
  CONSTRAINT approval_requests_once UNIQUE (org_id, work_item_id, action_class)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON approval_requests (org_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_requests_org_isolation ON approval_requests;
CREATE POLICY approval_requests_org_isolation ON approval_requests
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO darex_app;

-- ── How much rope each action class has earned ─────────────────────────────
CREATE TABLE IF NOT EXISTS org_action_autonomy (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  action_class   TEXT NOT NULL,

  -- ask     stop and wait for a person (the default, and the only default)
  -- notify  do it, and tell them it was done
  -- silent  do it; it is in the log if they want it
  level          TEXT NOT NULL DEFAULT 'ask'
                 CHECK (level IN ('ask', 'notify', 'silent')),

  -- The evidence. Reset to zero by any rejection, because a run of approvals
  -- interrupted by a "no" is not a run.
  consecutive_approvals INT NOT NULL DEFAULT 0,
  total_approvals       INT NOT NULL DEFAULT 0,
  total_rejections      INT NOT NULL DEFAULT 0,
  last_rejected_at      TIMESTAMPTZ,

  promoted_at    TIMESTAMPTZ,
  -- NULL means the system promoted it on evidence; a user id means a person
  -- overrode. Both are auditable, and they are not the same thing.
  promoted_by    UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT org_action_autonomy_once UNIQUE (org_id, action_class)
);

ALTER TABLE org_action_autonomy ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_action_autonomy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_action_autonomy_org_isolation ON org_action_autonomy;
CREATE POLICY org_action_autonomy_org_isolation ON org_action_autonomy
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_action_autonomy TO darex_app;

/**
 * Which action classes may EVER stop asking.
 *
 * This is the most important function in the migration, and it is a hard
 * allowlist rather than a setting, because the difference between a product a
 * business trusts and one that frightens them is whether "it learned to do
 * more" can ever mean "it paid someone without asking".
 *
 *   send, publish, price   a mistake is embarrassing and recoverable
 *   pay, sign, legal       a mistake is money, a contract, or a regulator
 *   pack_banned            a compliance stop; graduating it defeats its purpose
 *
 * No amount of approval history promotes the second group. An operator who
 * genuinely wants that must change this function in a migration, with a code
 * review and a deploy — which is exactly the amount of friction that decision
 * deserves.
 */
CREATE OR REPLACE FUNCTION action_class_may_graduate(p_action_class TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_action_class IN ('send', 'publish', 'price');
$$;

/**
 * Approvals in a row before an action class moves up a level.
 *
 * Ten, and deliberately slow. Trust that arrives in an afternoon is not trust,
 * and the failure mode of promoting too early — an unattended action a
 * business did not expect — costs far more than the operator clicks it saves.
 */
CREATE OR REPLACE FUNCTION autonomy_promotion_threshold()
RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT 10 $$;

/** What the agent should do for this class right now. Defaults to asking. */
CREATE OR REPLACE FUNCTION autonomy_level_for(p_org_id UUID, p_action_class TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT level FROM org_action_autonomy
      WHERE org_id = p_org_id AND action_class = p_action_class),
    'ask');
$$;

-- ── Recording a request ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION record_approval_request(
  p_org_id          UUID,
  p_work_item_id    UUID,
  p_conversation_id UUID,
  p_action_class    TEXT,
  p_summary         TEXT,
  p_draft           TEXT,
  p_workflow_id     TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO approval_requests
    (org_id, work_item_id, conversation_id, action_class, summary, draft, temporal_workflow_id)
  VALUES
    (p_org_id, p_work_item_id, p_conversation_id, p_action_class,
     COALESCE(btrim(p_summary), ''), COALESCE(p_draft, ''), p_workflow_id)
  ON CONFLICT (org_id, work_item_id, action_class) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── Deciding one, and moving the trust dial ────────────────────────────────
/**
 * Approve or reject, and update what that class has earned.
 *
 * Returns the new autonomy level so the caller can tell the operator when
 * their decision has just changed how the agent behaves — a promotion nobody
 * is told about is a surprise waiting to happen.
 */
-- Dropped first: CREATE OR REPLACE cannot change a function's OUT parameters,
-- so a re-applied migration that renames them fails with "cannot change return
-- type of existing function". Dropping makes this migration re-runnable, which
-- matters on any deployment that has an earlier version of it.
DROP FUNCTION IF EXISTS decide_approval(UUID, UUID, TEXT, UUID, TEXT);
CREATE OR REPLACE FUNCTION decide_approval(
  p_org_id      UUID,
  p_request_id  UUID,
  p_decision    TEXT,
  p_user_id     UUID,
  p_reason      TEXT DEFAULT NULL
) -- OUT parameters are deliberately prefixed. Naming one of them `action_class`
-- shadowed the identically named COLUMN on both approval_requests and
-- org_action_autonomy, and every WHERE inside this function failed with
-- "column reference action_class is ambiguous" — at runtime, on a function
-- that had compiled and deployed cleanly.
RETURNS TABLE (out_action_class TEXT, out_new_level TEXT, out_promoted BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class    TEXT;
  v_level    TEXT;
  v_streak   INT;
  v_promoted BOOLEAN := FALSE;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'decision must be approved or rejected, got %', p_decision;
  END IF;

  UPDATE approval_requests
     SET status = p_decision, decided_by = p_user_id, decided_at = NOW(),
         reason = p_reason
   WHERE approval_requests.id = p_request_id
     AND approval_requests.org_id = p_org_id
     AND approval_requests.status = 'pending'
   RETURNING approval_requests.action_class INTO v_class;

  IF v_class IS NULL THEN
    RAISE EXCEPTION 'no pending approval % for this org', p_request_id;
  END IF;

  INSERT INTO org_action_autonomy (org_id, action_class)
  VALUES (p_org_id, v_class)
  ON CONFLICT (org_id, action_class) DO NOTHING;

  IF p_decision = 'rejected' THEN
    -- One rejection drops the class all the way back to asking, and resets the
    -- streak. Not one level down: a person stopping the agent is the strongest
    -- signal available, and treating it as a minor deduction would let a class
    -- hover at 'silent' while being rejected regularly.
    UPDATE org_action_autonomy
       SET level = 'ask', consecutive_approvals = 0,
           total_rejections = total_rejections + 1,
           last_rejected_at = NOW(), promoted_at = NULL, promoted_by = NULL,
           updated_at = NOW()
     WHERE org_action_autonomy.org_id = p_org_id
       AND org_action_autonomy.action_class = v_class
     RETURNING org_action_autonomy.level INTO v_level;
  ELSE
    UPDATE org_action_autonomy
       SET consecutive_approvals = consecutive_approvals + 1,
           total_approvals = total_approvals + 1,
           updated_at = NOW()
     WHERE org_action_autonomy.org_id = p_org_id
       AND org_action_autonomy.action_class = v_class
     RETURNING org_action_autonomy.consecutive_approvals,
               org_action_autonomy.level INTO v_streak, v_level;

    IF action_class_may_graduate(v_class)
       AND v_streak >= autonomy_promotion_threshold() THEN
      UPDATE org_action_autonomy
         SET level = CASE level WHEN 'ask' THEN 'notify'
                                WHEN 'notify' THEN 'silent'
                                ELSE level END,
             consecutive_approvals = 0,
             promoted_at = CASE WHEN level <> 'silent' THEN NOW() ELSE promoted_at END,
             updated_at = NOW()
       WHERE org_action_autonomy.org_id = p_org_id
         AND org_action_autonomy.action_class = v_class
       RETURNING org_action_autonomy.level INTO v_level;
      v_promoted := TRUE;
    END IF;
  END IF;

  RETURN QUERY SELECT v_class, v_level, v_promoted;
END;
$$;

REVOKE ALL ON FUNCTION record_approval_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION decide_approval(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_approval_request(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION decide_approval(UUID, UUID, TEXT, UUID, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION autonomy_level_for(UUID, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION action_class_may_graduate(TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION autonomy_promotion_threshold() TO darex, darex_app;

/**
 * Revoke everything an org has granted, in one statement.
 *
 * The button a business needs on the day something goes wrong. It must be one
 * call, take effect on the next action rather than the next cycle, and require
 * no reasoning about which classes are where — because the person reaching for
 * it is not in a state to reason about that.
 */
CREATE OR REPLACE FUNCTION revoke_all_autonomy(p_org_id UUID, p_user_id UUID DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT;
BEGIN
  UPDATE org_action_autonomy
     SET level = 'ask', consecutive_approvals = 0,
         promoted_at = NULL, promoted_by = p_user_id, updated_at = NOW()
   WHERE org_id = p_org_id AND level <> 'ask';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION revoke_all_autonomy(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_all_autonomy(UUID, UUID) TO darex, darex_app;
