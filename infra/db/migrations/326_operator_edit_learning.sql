-- 026: learn from what a human CORRECTS, not only from what the agent misses.
--
-- WHY
-- Migration 025 records questions the agent could not answer, so an operator
-- can teach it. That covers the agent knowing nothing. It does not cover the
-- more common and more damaging case: the agent answers, the answer is subtly
-- wrong or badly judged, a human rewrites it before sending — and that rewrite,
-- the single highest-quality training signal in the whole system, is thrown
-- away.
--
-- An operator editing a reply is a domain expert saying "not that, THIS", about
-- a real customer, in their own voice. Nothing else the product collects comes
-- close. Every edit should make the same mistake impossible tomorrow.
--
-- WHAT THIS DOES NOT DO
-- An edit never overrides a security refusal or a grounded fact. A human
-- rewriting "I can't share another customer's number" into something that does
-- share it must not teach the agent to leak. That guard lives in
-- record_reply_edit() below and is asserted in the regression tests.

-- ── Priority on org_memory ─────────────────────────────────────────────────
-- Corrections must outrank raw ingested text. If a PDF says one thing and a
-- human corrected the agent to say another, the human wins.
ALTER TABLE org_memory
  ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN org_memory.priority IS
  'Retrieval weight. 0 = ingested document. 100 = human correction, which '
  'outranks ingested text for the same query. Set by record_reply_edit().';

CREATE INDEX IF NOT EXISTS idx_org_memory_priority
  ON org_memory (org_id, priority DESC);

-- ── The edit ledger ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reply_edits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

  -- What the customer asked. Without this the correction is an orphan: a right
  -- answer to an unknown question teaches nothing.
  question        TEXT NOT NULL,
  -- What the agent proposed, kept so the failure mode stays visible.
  ai_draft        TEXT NOT NULL,
  -- What the human actually sent. This is the lesson.
  operator_final  TEXT NOT NULL,

  -- Rejected edits still record the correction attempt but teach nothing.
  learned         BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason     TEXT,
  memory_id       UUID REFERENCES org_memory(id) ON DELETE SET NULL,

  edited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reply_edits_org
  ON reply_edits (org_id, created_at DESC);

ALTER TABLE reply_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_edits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reply_edits_rw ON reply_edits;
CREATE POLICY reply_edits_rw ON reply_edits
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON reply_edits TO darex_app;

-- ── Capture an edit, and learn from it when it is safe to ──────────────────
--
-- Returns the reply_edits row id. `learned` says whether the correction became
-- knowledge; `skip_reason` says why not.
CREATE OR REPLACE FUNCTION record_reply_edit(
  p_org_id          UUID,
  p_conversation_id UUID,
  p_question        TEXT,
  p_ai_draft        TEXT,
  p_operator_final  TEXT,
  p_edited_by       UUID DEFAULT NULL
) RETURNS TABLE (edit_id UUID, learned BOOLEAN, skip_reason TEXT, memory_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_edit_id   UUID;
  v_memory_id UUID;
  v_skip      TEXT;
  v_question  TEXT := btrim(COALESCE(p_question, ''));
  v_final     TEXT := btrim(COALESCE(p_operator_final, ''));
  v_draft     TEXT := btrim(COALESCE(p_ai_draft, ''));
BEGIN
  -- A "correction" that changed nothing is an operator pressing send.
  IF v_final = v_draft THEN
    v_skip := 'unchanged';

  -- Too short to carry a fact. "ok", "sent", "thanks" teach nothing and would
  -- pollute retrieval with noise that outranks real documents.
  ELSIF length(v_final) < 20 THEN
    v_skip := 'too_short';

  -- No question to attach it to.
  ELSIF length(v_question) < 3 THEN
    v_skip := 'no_question';

  -- SECURITY. If the agent correctly refused — privacy, or a request for
  -- internal instructions — a human rewriting that refusal must NEVER become
  -- a durable fact. Otherwise one operator having a bad day permanently
  -- teaches the agent to leak, and the refusal gates are silently defeated
  -- from the inside. Records the attempt; refuses to learn from it.
  ELSIF v_draft ~* '(can''?t share other people|private to them|personal details|another customer|someone else''?s)'
     OR v_draft ~* '(can''?t share (my )?system prompt|internal instructions|not able to reveal)' THEN
    v_skip := 'security_refusal_not_learnable';

  -- An edit that itself looks like a leak must not be stored either.
  ELSIF v_final ~* '(org_?id|conversation_?id|employee_?id)\s*[=:]'
     OR v_final ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' THEN
    v_skip := 'edit_contains_internal_identifier';
  END IF;

  IF v_skip IS NULL THEN
    -- Store the question WITH the answer: retrieval is full-text over
    -- title+body, so keeping the customer's own phrasing makes the next
    -- identical question match on the words customers actually use.
    INSERT INTO org_memory (
      org_id, kind, title, body, source, source_ref, content_hash, priority
    ) VALUES (
      p_org_id,
      'correction',
      left(v_question, 120),
      v_question || E'\n' || v_final,
      'operator_edit',
      COALESCE(p_conversation_id::text, 'manual'),
      encode(digest(p_org_id::text || v_question || v_final, 'sha256'), 'hex'),
      100  -- outranks ingested documents
    )
    ON CONFLICT (org_id, source, source_ref, content_hash) DO UPDATE
      SET body = EXCLUDED.body, priority = 100, updated_at = NOW()
    RETURNING id INTO v_memory_id;
  END IF;

  INSERT INTO reply_edits (
    org_id, conversation_id, question, ai_draft, operator_final,
    learned, skip_reason, memory_id, edited_by
  ) VALUES (
    p_org_id, p_conversation_id, v_question, v_draft, v_final,
    v_skip IS NULL, v_skip, v_memory_id, p_edited_by
  )
  RETURNING id INTO v_edit_id;

  RETURN QUERY SELECT v_edit_id, (v_skip IS NULL), v_skip, v_memory_id;
END;
$$;

COMMENT ON FUNCTION record_reply_edit IS
  'Captures an operator rewriting an AI reply and, when safe, turns it into a '
  'priority-100 org_memory fact. Never learns from an edited security refusal.';
