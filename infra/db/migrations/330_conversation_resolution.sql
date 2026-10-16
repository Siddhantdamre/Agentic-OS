-- 030: decide when a conversation is FINISHED, and whether a human was needed.
--
-- WHY
-- The outcome ledger (022/023) can materialise `conversation_resolved`, and it
-- reads conversations.resolved_at to do it. Measured on the live database:
--
--   status           count   with resolved_at
--   open               648                  0
--   needs_attention     54                  0
--
-- Nothing has ever set it. resolved_at is written by exactly one code path — a
-- manual PATCH on /api/conversations/{id} — which no screen calls. So every
-- conversation stays open forever, the most valuable outcome in the ledger
-- never materialises, and any resolution-rate metric reads 0% not because the
-- agent failed but because nobody ever wrote down that it succeeded.
--
-- That is the difference between a product that can prove its value and one
-- that asks to be believed.
--
-- WHAT "RESOLVED" MEANS HERE
-- A conversation is finished when the customer stopped needing anything: the
-- last thing said was the business's answer, and the customer did not come
-- back. That is a conservative reading — a customer who is dissatisfied
-- usually replies — and it is the only one derivable without asking them.
--
-- The autonomy split is the number that matters:
--
--   autonomous     the agent handled it start to finish, no human message
--   with_human     a person had to step in at some point
--
-- "91% handled without a human" comes from exactly this, and the two must
-- never be collapsed: a business paying for an AI employee is buying the first
-- number, and reporting the total would hide the trend that justifies renewal.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
-- It does not touch needs_attention. A conversation escalated for review is
-- not finished because it went quiet — it is waiting on somebody, and closing
-- it would turn an unmet obligation into a success metric. That is the one
-- error here that would be actively dishonest, so it is excluded in the WHERE
-- clause rather than in a comment.

-- ── Where the resolution kind is recorded ──────────────────────────────────
-- In metadata rather than a new column: the ledger reads conversations for
-- exactly one thing, and a jsonb key needs no backfill for the 702 rows that
-- already exist.
COMMENT ON COLUMN conversations.metadata IS
  'Free-form conversation state. `resolution` is set by '
  'close_quiet_conversations(): {"kind":"autonomous"|"with_human", '
  '"closed_by":"quiet_sweep","quiet_hours":N}.';

/**
 * Close conversations that have gone quiet, and say who did the work.
 *
 * Idempotent: only rows with resolved_at IS NULL are touched, and resolved_at
 * is set to the LAST MESSAGE time, not NOW(). That matters more than it looks.
 * Using NOW() would make the resolution timestamp depend on when a cron
 * happened to fire, so a missed run would shift every conversation's recorded
 * close time and the ledger's windowed counts would change on re-run. A
 * customer's reported ROI must not depend on cron punctuality.
 */
CREATE OR REPLACE FUNCTION close_quiet_conversations(
  p_org_id      UUID,
  p_quiet_hours INT DEFAULT 24
)
RETURNS TABLE (resolved_autonomous BIGINT, resolved_with_human BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org id is required';
  END IF;
  IF p_quiet_hours IS NULL OR p_quiet_hours < 1 THEN
    RAISE EXCEPTION 'quiet_hours must be at least 1, got %', p_quiet_hours;
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT
      c.id,
      MAX(m.created_at)                                      AS last_at,
      -- What role spoke last. A conversation ending on a CUSTOMER message is
      -- not finished — somebody still owes them an answer.
      (ARRAY_AGG(m.role ORDER BY m.created_at DESC))[1]      AS last_role,
      BOOL_OR(m.role = 'human_agent')                        AS human_spoke,
      BOOL_OR(m.role = 'assistant')                          AS agent_spoke
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id AND m.org_id = c.org_id
    WHERE c.org_id = p_org_id
      AND c.resolved_at IS NULL
      -- needs_attention is an open obligation, not a quiet success.
      AND c.status = 'open'
    GROUP BY c.id
  ),
  finished AS (
    SELECT
      id,
      last_at,
      CASE WHEN human_spoke THEN 'with_human' ELSE 'autonomous' END AS kind
    FROM candidate
    WHERE last_at < NOW() - (p_quiet_hours || ' hours')::interval
      -- The business spoke last, and the customer did not come back.
      AND last_role IN ('assistant', 'human_agent')
      -- Somebody actually answered. A thread where only the customer ever
      -- spoke is an unanswered question, and closing it would count a failure
      -- as a resolution.
      AND (agent_spoke OR human_spoke)
  ),
  updated AS (
    UPDATE conversations c
       -- 'resolved', not 'done'. That is the word the rest of the system
       -- already speaks: /api/conversations/{id} writes 'resolved' on a manual
       -- close, and the list endpoint counts `status = 'resolved'` into its
       -- stats. Inventing a second word for the same state would have made
       -- every swept conversation invisible to the dashboard's own counters —
       -- the UI would still have read zero resolved, which is precisely the
       -- bug this migration exists to fix.
       SET resolved_at = f.last_at,
           status      = 'resolved',
           updated_at  = NOW(),
           metadata    = COALESCE(c.metadata, '{}'::jsonb) || jsonb_build_object(
             'resolution', jsonb_build_object(
               'kind',        f.kind,
               'closed_by',   'quiet_sweep',
               'quiet_hours', p_quiet_hours
             ))
      FROM finished f
     WHERE c.id = f.id AND c.org_id = p_org_id
     RETURNING f.kind
  )
  SELECT
    COUNT(*) FILTER (WHERE kind = 'autonomous'),
    COUNT(*) FILTER (WHERE kind = 'with_human')
  FROM updated;
END;
$$;

COMMENT ON FUNCTION close_quiet_conversations(UUID, INT) IS
  'Close conversations whose last message was the business answering and that '
  'have been quiet for p_quiet_hours. Records whether a human was involved. '
  'Never closes needs_attention — that is an open obligation, not a success.';

REVOKE ALL ON FUNCTION close_quiet_conversations(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_quiet_conversations(UUID, INT) TO darex, darex_app;

-- Fail loudly if a future CHECK constraint stops allowing 'resolved'. Checked
-- rather than assumed: the UPDATE above would fail on such a constraint, and
-- the failure would surface as "no conversations ever resolve" — the exact bug
-- this migration exists to fix, wearing a different hat.
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'conversations'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%';

  IF def IS NOT NULL AND def NOT ILIKE '%resolved%' THEN
    RAISE EXCEPTION
      'conversations.status CHECK does not allow ''resolved'': %  — widen it before applying 030', def;
  END IF;
END;
$$;

-- Resolution sweeps read "open conversations for this org, oldest activity
-- first". Without this the sweep is a sequential scan per org per run.
CREATE INDEX IF NOT EXISTS idx_conversations_org_open_unresolved
  ON conversations (org_id, updated_at)
  WHERE resolved_at IS NULL;
