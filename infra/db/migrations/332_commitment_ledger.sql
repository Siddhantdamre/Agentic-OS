-- 032: when the agent promises something, remember it.
--
-- WHY
-- The agent says "I'll check and get back to you" and nothing anywhere
-- remembers it. The turn ends and the promise evaporates. Grepping the repo
-- for a follow-up, due-date or callback concept found nothing outside the rent
-- pack — there was no notion of an obligation at all.
--
-- This is the single biggest reason an AI assistant feels unreliable. Not
-- wrong answers: people forgive a wrong answer and ask again. An UNKEPT
-- PROMISE is different. The customer waits, nothing arrives, and they conclude
-- the business does not care. One of those costs more trust than ten wrong
-- answers, and it is invisible in every metric this system had — the
-- conversation looks resolved, the reply looks good, and the customer is gone.
--
-- WHAT COUNTS AS KEPT
-- The business speaking again in that conversation, by anyone, before the
-- deadline. Not "the agent sent something specific" — a colleague picking up
-- the phone is a kept promise too, and a ledger that only counts machine
-- follow-ups would report a business as unreliable precisely when its people
-- stepped in.
--
-- WHAT HAPPENS WHEN ONE COMES DUE
-- It escalates to a human. Deliberately NOT an automatic follow-up message:
-- that means generating outbound customer text unattended, and reliability x20
-- has not passed. An overdue promise surfacing on somebody's screen is worth
-- most of the value and carries none of that risk. Automatic follow-up is a
-- later step, once the reliability gate is met.

CREATE TABLE IF NOT EXISTS commitments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  work_item_id    UUID,

  -- The sentence, verbatim. An operator has to be able to read what was
  -- actually promised — "follow up with the customer" is useless, and the
  -- customer's own words are what they will hold the business to.
  promise         TEXT NOT NULL,
  -- The customer's question, so whoever picks this up has the context.
  question        TEXT NOT NULL DEFAULT '',

  due_at          TIMESTAMPTZ NOT NULL,

  -- open       still within time, nothing has happened yet
  -- kept       the business spoke again before the deadline
  -- broken     the deadline passed in silence
  -- cancelled  the conversation ended or the customer resolved it themselves
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'kept', 'broken', 'cancelled')),

  settled_at      TIMESTAMPTZ,
  -- Which message discharged it, so "kept" is auditable rather than asserted.
  settled_by      TEXT,
  escalated_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One promise per reply. A Temporal retry replaying the same turn must not
  -- open a second obligation for the same sentence, or the kept-promise rate
  -- would fall every time the platform retried itself.
  source_message_id TEXT,
  CONSTRAINT commitments_once UNIQUE (org_id, source_message_id)
);

COMMENT ON TABLE commitments IS
  'Promises the agent made and whether they were kept. A promise is kept when '
  'the business speaks again in that conversation before the deadline — by '
  'anyone, agent or human.';

-- The sweep reads "open and overdue, oldest first".
CREATE INDEX IF NOT EXISTS idx_commitments_due
  ON commitments (org_id, due_at) WHERE status = 'open';

ALTER TABLE commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE commitments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commitments_org_isolation ON commitments;
CREATE POLICY commitments_org_isolation ON commitments
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON commitments TO darex_app;

-- ── Recording one ──────────────────────────────────────────────────────────
/**
 * Open an obligation.
 *
 * due_at is computed HERE, from a relative offset the caller supplies, because
 * the caller is a Temporal workflow and `new Date()` inside workflow code is
 * non-deterministic across replay. The detector returns minutes; the database
 * owns the clock.
 */
CREATE OR REPLACE FUNCTION record_commitment(
  p_org_id          UUID,
  p_conversation_id UUID,
  p_work_item_id    UUID,
  p_promise         TEXT,
  p_question        TEXT,
  p_due_in_minutes  INT,
  p_source_message_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_promise IS NULL OR btrim(p_promise) = '' THEN
    RAISE EXCEPTION 'a commitment needs the sentence that made it';
  END IF;

  INSERT INTO commitments
    (org_id, conversation_id, work_item_id, promise, question, due_at, source_message_id)
  VALUES
    (p_org_id, p_conversation_id, p_work_item_id,
     btrim(p_promise), COALESCE(btrim(p_question), ''),
     NOW() + (GREATEST(COALESCE(p_due_in_minutes, 240), 5) || ' minutes')::interval,
     p_source_message_id)
  ON CONFLICT (org_id, source_message_id) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION record_commitment(UUID, UUID, UUID, TEXT, TEXT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_commitment(UUID, UUID, UUID, TEXT, TEXT, INT, TEXT) TO darex, darex_app;

-- ── Settling them ──────────────────────────────────────────────────────────
/**
 * Close out every commitment whose fate is now decided.
 *
 * Runs before the overdue sweep so a promise kept five minutes ago is never
 * escalated. Idempotent: only rows still 'open' are touched.
 *
 * Returns the counts so a caller can report them rather than guess.
 */
CREATE OR REPLACE FUNCTION settle_commitments(p_org_id UUID)
RETURNS TABLE (kept BIGINT, broken BIGINT, cancelled BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH decided AS (
    SELECT
      c.id,
      -- Did anyone from the business speak AFTER, and SEPARATELY FROM, the
      -- promise?
      --
      -- created_at, not due_at: a follow-up counts from the moment the promise
      -- was made, and one sent early is still one kept.
      --
      -- The content exclusion is load-bearing, not defensive. WorkItemWorkflow
      -- records the commitment BEFORE it saves the reply, so the very message
      -- carrying "I'll get back to you" lands with a later timestamp than the
      -- obligation it created — and without this clause it discharged its own
      -- promise. Every commitment would have been marked kept within seconds
      -- and the kept-promise rate would have read 100% forever: a trust metric
      -- that is a lie, in the flattering direction, which is the worst kind.
      --
      -- Matching on content rather than on ordering also makes this correct
      -- regardless of how the workflow is sequenced later, and it is
      -- semantically right on its own terms: a message that repeats the same
      -- promise is not a follow-up to it.
      (SELECT m.id FROM messages m
        WHERE m.org_id = c.org_id
          AND m.conversation_id = c.conversation_id
          AND m.role IN ('assistant', 'human_agent')
          AND m.created_at > c.created_at
          AND position(c.promise in m.content) = 0
        ORDER BY m.created_at
        LIMIT 1) AS follow_up_id,
      conv.status AS conv_status
    FROM commitments c
    LEFT JOIN conversations conv
      ON conv.id = c.conversation_id AND conv.org_id = c.org_id
    WHERE c.org_id = p_org_id
      AND c.status = 'open'
  ),
  updated AS (
    UPDATE commitments c
       SET status = CASE
             WHEN d.follow_up_id IS NOT NULL THEN 'kept'
             -- A conversation the customer themselves closed out is not a
             -- broken promise. Counting it as one would punish the business
             -- for a customer who no longer needed the answer.
             WHEN d.conv_status = 'resolved' THEN 'cancelled'
             WHEN c.due_at < NOW() THEN 'broken'
             ELSE 'open'
           END,
           settled_at = CASE
             WHEN d.follow_up_id IS NOT NULL OR d.conv_status = 'resolved' OR c.due_at < NOW()
             THEN NOW() ELSE NULL END,
           settled_by = d.follow_up_id::text
      FROM decided d
     WHERE c.id = d.id
       AND (d.follow_up_id IS NOT NULL OR d.conv_status = 'resolved' OR c.due_at < NOW())
     RETURNING c.status
  )
  SELECT
    COUNT(*) FILTER (WHERE status = 'kept'),
    COUNT(*) FILTER (WHERE status = 'broken'),
    COUNT(*) FILTER (WHERE status = 'cancelled')
  FROM updated;
END;
$$;

REVOKE ALL ON FUNCTION settle_commitments(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_commitments(UUID) TO darex, darex_app;
