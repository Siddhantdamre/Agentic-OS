-- 042: three roles on every task — and a record that all three ran.
--
-- WHY
-- The three roles already execute on every work item:
--
--   DOER      executeChild(AutonomousAgentWorkflow) — produces the reply
--   MONITOR   criticCheckWithRevision, grounding, the deterministic reply
--             gates — judges it before anyone sees it
--   LEARNER   recordKnowledgeGap, MemoryWriteBackWorkflow — turns what
--             happened into what the agent knows next time
--
-- What did not exist was any record that they ran. Their traces are scattered
-- across work_events under a dozen different kinds, so "was this task
-- supervised?" could only be answered by reconstructing a timeline and hoping
-- nothing was missing. A supervisor nobody can confirm ran is indistinguishable
-- from one that silently stopped — which is exactly how four features in this
-- codebase were built, tested, and unreachable.
--
-- ── WHY NOT THREE AGENTS ──────────────────────────────────────────────────
-- Because the roles are what matter, not the mechanism. One conversation on
-- this deployment measures ~99,000 tokens across three model calls. Making the
-- monitor and the learner into LLM agents would take that past 300,000 for no
-- correctness gain: the monitor is ALREADY deterministic where it counts (fair
-- housing, guaranteed returns, invented legal promises are pattern rules that
-- do not need a model and cannot be talked out of their verdict), and the
-- learner reads outcomes rather than reasoning about them.
--
-- A model is used by the monitor only to TIGHTEN a verdict the deterministic
-- layer already allowed, never to loosen one it refused. So the expensive role
-- is optional and the cheap roles are mandatory, which is the correct way
-- round.
--
-- ── WHAT THIS TABLE IS FOR ────────────────────────────────────────────────
-- One row per task. It answers, without reconstruction:
--
--   did all three roles run?
--   what did the monitor decide, and did it change the answer?
--   what did the learner take away, and did it come from the monitor's verdict?
--
-- The third question is the one that was previously unanswerable, and it is
-- the one that decides whether this system improves.

CREATE TABLE IF NOT EXISTS task_supervision (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  work_item_id  UUID REFERENCES work_items(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,

  -- ── DOER ────────────────────────────────────────────────────────────────
  -- replied      it produced an answer
  -- failed       it could not
  -- refused      it declined on purpose (a security refusal is a good outcome)
  -- escalated    it stopped and asked a human
  doer_outcome  TEXT NOT NULL
                CHECK (doer_outcome IN ('replied', 'failed', 'refused', 'escalated')),
  doer_turns    INTEGER NOT NULL DEFAULT 0,

  -- ── MONITOR ─────────────────────────────────────────────────────────────
  -- passed       the answer went out as written
  -- revised      it was rewritten and then allowed
  -- blocked      it was refused and a human was asked
  -- skipped      there was no answer to judge
  monitor_verdict TEXT NOT NULL
                  CHECK (monitor_verdict IN ('passed', 'revised', 'blocked', 'skipped')),
  -- Which rule decided it. Free text because the deterministic gates and the
  -- model critic name different things, and flattening them into one taxonomy
  -- would lose the detail that makes a block explainable.
  monitor_reason  TEXT NOT NULL DEFAULT '',
  -- TRUE only when a MODEL was consulted. Most tasks should be false: if this
  -- trends toward 1.0 the deterministic layer has stopped carrying its share
  -- and the cost per conversation is quietly tripling.
  monitor_used_model BOOLEAN NOT NULL DEFAULT FALSE,

  -- ── LEARNER ─────────────────────────────────────────────────────────────
  -- nothing        the task taught nothing new, which is the common case
  -- gap_recorded   it could not answer, and the question was written down
  -- memory_written it learned durable facts from the conversation
  -- both
  learner_outcome TEXT NOT NULL DEFAULT 'nothing'
                  CHECK (learner_outcome IN ('nothing', 'gap_recorded', 'memory_written', 'both')),
  -- THE LINK THAT MAKES THIS A LOOP RATHER THAN THREE LOGS.
  --
  -- TRUE when what the learner recorded was caused by the monitor's verdict —
  -- the monitor blocked for a missing fact, so the learner opened a gap for
  -- it. Without this the three roles are three independent observers; with it
  -- they are a cycle, and "how often does being judged actually teach it
  -- something" becomes a number.
  learner_from_monitor BOOLEAN NOT NULL DEFAULT FALSE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE task_supervision IS
  'One row per task: what the doer did, what the monitor decided, what the '
  'learner took away, and whether the learning came from the judgement. '
  'Written once, at the end of the task, so a missing row means the task '
  'completed unsupervised.';

CREATE INDEX IF NOT EXISTS idx_task_supervision_org
  ON task_supervision (org_id, created_at DESC);
-- One row per work item. Re-running a workflow must not double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_supervision_item
  ON task_supervision (work_item_id) WHERE work_item_id IS NOT NULL;

ALTER TABLE task_supervision ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_supervision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_supervision_org_isolation ON task_supervision;
CREATE POLICY task_supervision_org_isolation ON task_supervision
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── Record the trio ─────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS record_task_supervision(UUID, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN);
CREATE FUNCTION record_task_supervision(
  p_org_id        UUID,
  p_work_item_id  UUID,
  p_conversation_id UUID,
  p_doer          TEXT,
  p_turns         INTEGER,
  p_verdict       TEXT,
  p_reason        TEXT,
  p_used_model    BOOLEAN,
  p_learner       TEXT,
  p_from_monitor  BOOLEAN
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'record_task_supervision: org is required';
  END IF;

  INSERT INTO task_supervision AS t
    (org_id, work_item_id, conversation_id, doer_outcome, doer_turns,
     monitor_verdict, monitor_reason, monitor_used_model,
     learner_outcome, learner_from_monitor)
  VALUES
    (p_org_id, p_work_item_id, p_conversation_id,
     COALESCE(p_doer, 'failed'), COALESCE(p_turns, 0),
     COALESCE(p_verdict, 'skipped'), COALESCE(p_reason, ''), COALESCE(p_used_model, FALSE),
     COALESCE(p_learner, 'nothing'), COALESCE(p_from_monitor, FALSE))
  ON CONFLICT (work_item_id) WHERE work_item_id IS NOT NULL DO UPDATE SET
    -- Assignment, not accumulation: a Temporal replay re-runs the workflow and
    -- must produce the same row, not a second observation of the same task.
    doer_outcome        = EXCLUDED.doer_outcome,
    doer_turns          = EXCLUDED.doer_turns,
    monitor_verdict     = EXCLUDED.monitor_verdict,
    monitor_reason      = EXCLUDED.monitor_reason,
    monitor_used_model  = EXCLUDED.monitor_used_model,
    learner_outcome     = EXCLUDED.learner_outcome,
    learner_from_monitor= EXCLUDED.learner_from_monitor
  RETURNING t.id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_task_supervision IS
  'Write the one supervision row for a task. Upsert is assignment, not '
  'accumulation, so a Temporal replay reproduces the row rather than '
  'double-counting the task.';

GRANT EXECUTE ON FUNCTION record_task_supervision(UUID, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN) TO darex_app;
