-- 025: knowledge gaps — the agent's own list of what it could not answer.
--
-- WHY
-- The agent used to reply "I don't have your business hours stored" and that
-- was the end of it. Nothing recorded the gap, so the same question failed
-- forever and the operator had no way of knowing what to teach it. The whole
-- point of an AI employee is that it gets better at THIS business over time;
-- without a record of misses it cannot.
--
-- HOW IT CLOSES
-- Every unanswered question lands here as `open`. The operator answers it once
-- — in the dashboard, or by correcting a reply — and the answer is written into
-- org_memory as an authoritative fact. Retrieval then finds it on every future
-- question, and the gap flips to `resolved`. One human correction, permanent
-- capability.
--
-- This deliberately does NOT capture questions the agent SHOULD refuse. A
-- request for another customer's phone number is not a knowledge gap, and
-- recording it as one would invite an operator to "fix" a correct refusal.

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- What was asked, verbatim. This is the training signal.
  question       TEXT NOT NULL,
  -- What the agent said instead of answering. Kept so an operator can judge
  -- whether the miss was a real gap or a retrieval failure.
  agent_reply    TEXT NOT NULL DEFAULT '',

  -- Dedupe key: normalised question text. The same question asked fifty times
  -- is ONE gap with a count of fifty, not fifty rows — and the count is exactly
  -- the priority signal for which gap to fill first.
  question_hash  TEXT NOT NULL,
  times_asked    INT  NOT NULL DEFAULT 1,

  -- open      → nobody has answered it yet
  -- resolved  → an answer was written to org_memory; memory_id points at it
  -- dismissed → the operator decided this is not something the agent should know
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved', 'dismissed')),
  memory_id      UUID REFERENCES org_memory(id) ON DELETE SET NULL,

  -- How the gap was detected, for measuring which path is leaking most:
  -- 'denied'      — the reply admitted it did not know
  -- 'corrected'   — a human replaced or edited the agent's reply
  -- 'no_reply'    — the chain produced nothing at all (provider failure)
  detected_via   TEXT NOT NULL DEFAULT 'denied'
                 CHECK (detected_via IN ('denied', 'corrected', 'no_reply')),

  conversation_id UUID,
  work_item_id    UUID,

  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,

  UNIQUE (org_id, question_hash)
);

CREATE INDEX IF NOT EXISTS knowledge_gaps_org_status_idx
  ON knowledge_gaps (org_id, status, times_asked DESC);

ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_gaps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_gaps_rw ON knowledge_gaps;
CREATE POLICY knowledge_gaps_rw ON knowledge_gaps
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON knowledge_gaps TO darex_app;

-- Record a miss, or bump the count if this question has been missed before.
-- Idempotent on (org_id, question_hash) so a retried activity cannot inflate
-- the count — the count must mean "customers asked this N times", not "the
-- workflow replayed N times".
CREATE OR REPLACE FUNCTION record_knowledge_gap(
  p_org_id          UUID,
  p_question        TEXT,
  p_agent_reply     TEXT,
  p_detected_via    TEXT,
  p_conversation_id UUID DEFAULT NULL,
  p_work_item_id    UUID DEFAULT NULL,
  p_dedupe_key      TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_hash TEXT;
  v_id   UUID;
BEGIN
  -- Normalise so "What are your hours?" and "what are your hours"
  -- are the same gap.
  v_hash := encode(digest(lower(regexp_replace(p_question, '[^a-zA-Z0-9 ]', '', 'g')), 'sha256'), 'hex');

  INSERT INTO knowledge_gaps (
    org_id, question, agent_reply, question_hash, detected_via,
    conversation_id, work_item_id
  )
  VALUES (
    p_org_id, p_question, COALESCE(p_agent_reply, ''), v_hash, p_detected_via,
    p_conversation_id, p_work_item_id
  )
  ON CONFLICT (org_id, question_hash) DO UPDATE
    SET times_asked  = knowledge_gaps.times_asked
                       + CASE WHEN p_dedupe_key IS NULL
                              OR knowledge_gaps.work_item_id IS DISTINCT FROM p_work_item_id
                         THEN 1 ELSE 0 END,
        last_seen_at = NOW(),
        agent_reply  = COALESCE(NULLIF(EXCLUDED.agent_reply, ''), knowledge_gaps.agent_reply)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Teach the agent an answer, and close the gap in one step.
--
-- This is the "self-learn through user review" loop: the operator supplies the
-- answer once, it becomes a first-class org_memory fact (so retrieval finds it
-- like any other knowledge), and the gap is marked resolved. Written as one
-- function so the two halves cannot drift apart — a resolved gap without the
-- memory row behind it would be a silent regression to "I don't know".
CREATE OR REPLACE FUNCTION resolve_knowledge_gap(
  p_org_id   UUID,
  p_gap_id   UUID,
  p_title    TEXT,
  p_answer   TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_memory_id UUID;
  v_question  TEXT;
BEGIN
  SELECT question INTO v_question
    FROM knowledge_gaps WHERE id = p_gap_id AND org_id = p_org_id;
  IF v_question IS NULL THEN
    RAISE EXCEPTION 'knowledge gap % not found for org %', p_gap_id, p_org_id;
  END IF;

  -- Store the question alongside the answer. Retrieval is full-text over
  -- title+body, so keeping the customer's own phrasing in the body makes the
  -- next identical question match on the words the customer actually uses.
  INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
  VALUES (
    p_org_id,
    'faq',
    COALESCE(NULLIF(p_title, ''), left(v_question, 120)),
    v_question || E'\n' || p_answer,
    'review',
    p_gap_id::text,
    encode(digest(p_org_id::text || v_question || p_answer, 'sha256'), 'hex')
  )
  -- Conflict target must match idx_org_memory_content_hash exactly
  -- (org_id, source, source_ref, content_hash) — naming content_hash alone
  -- raises "no unique or exclusion constraint matching the ON CONFLICT spec".
  ON CONFLICT (org_id, source, source_ref, content_hash) DO UPDATE
    SET body = EXCLUDED.body, updated_at = NOW()
  RETURNING id INTO v_memory_id;

  UPDATE knowledge_gaps
     SET status = 'resolved', memory_id = v_memory_id, resolved_at = NOW()
   WHERE id = p_gap_id AND org_id = p_org_id;

  RETURN v_memory_id;
END;
$$;
