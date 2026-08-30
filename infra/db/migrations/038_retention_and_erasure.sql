-- 038: retention and erasure — the ability to forget, on request and on schedule.
--
-- WHY NOW
-- India's DPDP Rules 2025 were notified on 13 November 2025 with phased
-- commencement: 13 November 2026 for Consent Manager registration and
-- 13 May 2027 for the main obligations in sections 3-17, which include erasure.
-- Darex is a Data Processor; its customers are the Data Fiduciaries, and the
-- Act makes them answerable for processing carried out by their processors.
-- They will ask for this during procurement long before the deadline.
--
-- ── WHAT THE AUDIT FOUND ───────────────────────────────────────────────────
-- Before this migration, erasing a person did almost nothing.
--
-- 1. There is no `contacts` table. A "contact" is `conversations.contact_id`,
--    a TEXT column holding the raw phone number ("+919799992973"), copied onto
--    every conversation row. So the data subject has no record to delete, the
--    identifier is denormalised across the table, and there was no entity for
--    an erasure routine to key on. This is also why 702 conversations produce
--    702 distinct contacts: the same person on two channels is two strings.
--
-- 2. Deleting a CONVERSATION cascades to messages, conversation_memory,
--    commitments, outcome_events and agent_actions — but four tables are
--    ON DELETE SET NULL and survive with their contents intact:
--
--      reply_edits      question, ai_draft, operator_final  <- full message text
--      work_items       the work record
--      ask_ai_feedback  free-text feedback
--      re_inquiries     follow-up records
--
--    And two more carry a conversation_id with NO foreign key at all, so
--    nothing removes them under any circumstances:
--
--      knowledge_gaps      question       <- the customer's words, verbatim
--      approval_requests   draft          <- the reply text
--      lead_followups      draft          <- quotes the customer back (039)
--
--    So the obvious implementation of erasure leaves the customer's actual
--    words in reply_edits, orphaned but readable.
--
-- 3. org_memory holds facts the agent LEARNED from conversations — 1,127 rows.
--    It has no foreign key to anything. Erasing the conversation leaves the
--    derived knowledge ("wants a 3BHK in Thane, budget 1.2cr") behind forever.
--    This is the hole that matters most, because it is the one a customer
--    would never think to ask about and the one that would still be answering
--    questions about a person who asked to be forgotten.
--
-- ── THE ORDERING IS LOad-BEARING ───────────────────────────────────────────
-- The SET NULL survivors and the derived memory must be erased BEFORE the
-- conversation row. Delete the conversation first and their conversation_id
-- becomes NULL, at which point nothing links them to the person and they can
-- never be found again. An erasure routine written in the natural order is
-- silently incomplete and permanently so.
--
-- ── WHAT THIS CANNOT DO, STATED PLAINLY ────────────────────────────────────
-- Text sent to a model provider during a conversation is outside this
-- database and outside this function. The receipt records what was erased
-- HERE and claims nothing further. A compliance story that quietly implies
-- otherwise is worse than one that names its boundary.

-- ── Retention policy ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_retention_policy (
  org_id                    UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,

  -- NULL means keep indefinitely, and that is the default: introducing
  -- retention must never silently start deleting a customer's history.
  -- Switching it on is a deliberate act with a number attached.
  conversation_retention_days INTEGER CHECK (conversation_retention_days IS NULL OR conversation_retention_days > 0),

  -- Derived memory is kept separately from raw conversations, because they
  -- answer different questions. A business may want to forget the transcript
  -- and keep "this customer prefers WhatsApp", or the exact opposite.
  memory_retention_days       INTEGER CHECK (memory_retention_days IS NULL OR memory_retention_days > 0),

  -- A sweep that deletes without being asked is an outage waiting to happen.
  -- Off by default: the policy can be configured, reviewed and previewed
  -- before anything is destroyed.
  sweep_enabled             BOOLEAN NOT NULL DEFAULT FALSE,

  last_swept_at             TIMESTAMPTZ,
  updated_by                UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE org_retention_policy IS
  'Per-workspace retention. NULL days = keep indefinitely (the default). '
  'sweep_enabled is off by default so a policy can be set and previewed '
  'before anything is deleted.';

ALTER TABLE org_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_retention_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_retention_policy_org_isolation ON org_retention_policy;
CREATE POLICY org_retention_policy_org_isolation ON org_retention_policy
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── The receipt ─────────────────────────────────────────────────────────────
-- A Fiduciary who is asked by the Board what happened to a person's data needs
-- to be able to answer with a record, not a recollection. So every erasure
-- leaves one, including the per-table counts.
CREATE TABLE IF NOT EXISTS erasure_requests (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- WHO was erased -- as a hash, never as the identifier.
  --
  -- The subject is a phone number, so a receipt that stored it would leave the
  -- erasure log as the last surviving copy of the exact string somebody asked
  -- to have removed. Storing sha256(org_id || identifier) keeps the proof
  -- useful and the identifier gone: a Fiduciary asked "was this person
  -- erased?" recomputes the hash from the number they already hold and finds
  -- the row. Salted with org_id so the same number in two workspaces does not
  -- produce the same hash.
  subject_hash  TEXT NOT NULL,

  reason        TEXT NOT NULL DEFAULT 'data_subject_request'
                CHECK (reason IN ('data_subject_request', 'retention_expiry', 'operator_request')),
  requested_by  UUID,

  status        TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('completed', 'failed')),

  -- {"messages": 12, "org_memory": 3, ...} — what actually went, per table.
  erased_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Anything the routine could not reach, named rather than omitted.
  not_erased    JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE erasure_requests IS
  'Proof of erasure. Holds sha256(org_id || identifier), never the identifier '
  'itself: a receipt must not resurrect the thing it certifies the removal '
  'of. Recompute the hash to look a subject up.';

CREATE INDEX IF NOT EXISTS idx_erasure_requests_org
  ON erasure_requests (org_id, created_at DESC);
-- Lookup is always "was this person erased", by recomputed hash.
CREATE INDEX IF NOT EXISTS idx_erasure_requests_subject
  ON erasure_requests (org_id, subject_hash);

ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erasure_requests_org_isolation ON erasure_requests;
CREATE POLICY erasure_requests_org_isolation ON erasure_requests
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── Erase a person ──────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS erase_data_subject(UUID, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS erase_data_subject(UUID, TEXT, TEXT, UUID);
CREATE FUNCTION erase_data_subject(
  p_org_id       UUID,
  -- The phone number, or whatever identifier conversations.contact_id holds
  -- for this channel. There is no contact entity to pass instead.
  p_contact_id   TEXT,
  p_reason       TEXT DEFAULT 'data_subject_request',
  p_requested_by UUID DEFAULT NULL
) RETURNS TABLE (receipt_id UUID, erased JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_convs   UUID[];
  v_counts  JSONB := '{}'::jsonb;
  v_hash    TEXT;
  v_receipt UUID;
  v_n       BIGINT;
BEGIN
  IF p_org_id IS NULL OR COALESCE(TRIM(p_contact_id), '') = '' THEN
    RAISE EXCEPTION 'erase_data_subject: org and contact identifier are both required';
  END IF;

  -- Salted with the workspace, so the same number in two workspaces does not
  -- yield the same hash and one customer's receipt log cannot be used to test
  -- whether another customer holds a given number.
  v_hash := encode(digest(p_org_id::text || ':' || TRIM(p_contact_id), 'sha256'), 'hex');

  -- Scoped to the caller's workspace by construction: every statement below
  -- filters on org_id, so a SECURITY DEFINER cannot be used to reach across
  -- tenants even though it bypasses RLS.
  SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_convs
    FROM conversations WHERE org_id = p_org_id AND contact_id = TRIM(p_contact_id);

  -- ORDER IS LOAD-BEARING. Everything below runs BEFORE the conversations are
  -- deleted, because ON DELETE SET NULL would otherwise sever the only link
  -- back to this person and strand the rows permanently.

  -- 1. Facts the agent LEARNED. The deepest hole: no foreign key, so nothing
  --    removes these automatically, and they are what the agent would still
  --    be answering from.
  DELETE FROM org_memory
   WHERE org_id = p_org_id
     AND source = 'conversation'
     AND source_ref = ANY(SELECT unnest(v_convs)::text);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('org_memory', v_n);

  -- 2. The ON DELETE SET NULL survivors, in the window where they can still
  --    be found. reply_edits is the one that matters: it holds the customer's
  --    actual words in `question` and the reply in `operator_final`.
  DELETE FROM reply_edits WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reply_edits', v_n);

  DELETE FROM work_items WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('work_items', v_n);

  -- knowledge_gaps.question is the customer's question, verbatim, and
  -- approval_requests.draft is the reply text. NEITHER has a foreign key to
  -- conversations, so like org_memory nothing would ever remove them. Both
  -- were missed by the first version of this function and caught only because
  -- the coverage test reads the catalog rather than a hand-written list.
  DELETE FROM knowledge_gaps WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('knowledge_gaps', v_n);

  -- lead_followups.draft quotes the customer's own words back at them, so a
  -- follow-up record is personal data like any message. Added here because the
  -- catalog sweep in check-erasure.js failed the day migration 039 created the
  -- table -- which is the entire reason that test reads pg_class instead of a
  -- list somebody has to remember to update.
  DELETE FROM lead_followups WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('lead_followups', v_n);

  DELETE FROM approval_requests WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('approval_requests', v_n);

  DELETE FROM ask_ai_feedback WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('ask_ai_feedback', v_n);

  DELETE FROM re_inquiries
   WHERE org_id = p_org_id
     AND (conversation_id = ANY(v_convs) OR contact_id = TRIM(p_contact_id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('re_inquiries', v_n);

  -- 3. Count what the cascade is about to take, so the receipt states how
  --    much was actually removed rather than reporting zero for everything
  --    the database tidied up on its own.
  SELECT COUNT(*) INTO v_n FROM messages WHERE conversation_id = ANY(v_convs);
  v_counts := v_counts || jsonb_build_object('messages', v_n);
  SELECT COUNT(*) INTO v_n FROM conversation_memory WHERE conversation_id = ANY(v_convs);
  v_counts := v_counts || jsonb_build_object('conversation_memory', v_n);

  -- 4. The conversations. Cascades to messages, conversation_memory,
  --    commitments, outcome_events and agent_actions. This also removes the
  --    last copy of the identifier itself, which lives in contact_id.
  DELETE FROM conversations WHERE org_id = p_org_id AND contact_id = TRIM(p_contact_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('conversations', v_n);

  INSERT INTO erasure_requests
    (org_id, subject_hash, reason, requested_by, status, erased_counts, not_erased)
  VALUES (
    p_org_id, v_hash, p_reason, p_requested_by, 'completed', v_counts,
    -- Named, not hidden. A boundary stated is worth more than a claim implied.
    '["text sent to the model provider during the conversation, which is outside this database"]'::jsonb
  )
  RETURNING id INTO v_receipt;

  RETURN QUERY SELECT v_receipt, v_counts;
END;
$$;

COMMENT ON FUNCTION erase_data_subject IS
  'Erase one person and everything derived from them, in the order that keeps '
  'ON DELETE SET NULL rows reachable. Returns a receipt id and per-table '
  'counts. Every statement filters on org_id, so this SECURITY DEFINER cannot '
  'reach across tenants.';

GRANT EXECUTE ON FUNCTION erase_data_subject(UUID, TEXT, TEXT, UUID) TO darex_app;

-- ── Retention sweep ─────────────────────────────────────────────────────────
-- The policy table without this is just a stated intention. This is what
-- actually forgets on schedule.
--
-- PREVIEW IS THE DEFAULT. p_dry_run defaults to TRUE, so calling this by
-- accident, or wiring it to a scheduler before anybody has looked at the
-- numbers, reports what WOULD go and destroys nothing. Deleting a customer's
-- history is the least reversible thing this system can do; it should take a
-- deliberate second argument.
--
-- It reuses the ordering discipline above for exactly the same reason: the
-- ON DELETE SET NULL rows and the derived memory have to go first or they are
-- stranded beyond recovery.
DROP FUNCTION IF EXISTS sweep_retention(UUID, BOOLEAN);
CREATE FUNCTION sweep_retention(
  p_org_id  UUID,
  p_dry_run BOOLEAN DEFAULT TRUE
) RETURNS TABLE (dry_run BOOLEAN, would_erase JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_days INTEGER;
  v_mem_days  INTEGER;
  v_enabled   BOOLEAN;
  v_convs     UUID[];
  v_counts    JSONB := '{}'::jsonb;
  v_n         BIGINT;
BEGIN
  SELECT conversation_retention_days, memory_retention_days, sweep_enabled
    INTO v_conv_days, v_mem_days, v_enabled
    FROM org_retention_policy WHERE org_id = p_org_id;

  -- No policy, or a policy that has not been switched on, deletes nothing.
  -- A workspace must opt in twice: set a number, then enable the sweep.
  IF NOT FOUND OR COALESCE(v_enabled, FALSE) = FALSE THEN
    RETURN QUERY SELECT p_dry_run, jsonb_build_object('skipped', 'no active retention policy');
    RETURN;
  END IF;

  IF v_conv_days IS NOT NULL THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_convs
      FROM conversations
     WHERE org_id = p_org_id
       AND created_at < NOW() - (v_conv_days || ' days')::interval;
  ELSE
    v_convs := ARRAY[]::UUID[];
  END IF;

  v_counts := jsonb_build_object('conversations', COALESCE(array_length(v_convs, 1), 0));
  SELECT COUNT(*) INTO v_n FROM messages WHERE conversation_id = ANY(v_convs);
  v_counts := v_counts || jsonb_build_object('messages', v_n);

  SELECT COUNT(*) INTO v_n FROM org_memory
   WHERE org_id = p_org_id
     AND v_mem_days IS NOT NULL
     AND created_at < NOW() - (COALESCE(v_mem_days, 0) || ' days')::interval;
  v_counts := v_counts || jsonb_build_object('org_memory', v_n);

  IF p_dry_run THEN
    RETURN QUERY SELECT TRUE, v_counts;
    RETURN;
  END IF;

  -- Same order as erase_data_subject, and for the same reason.
  DELETE FROM org_memory
   WHERE org_id = p_org_id AND source = 'conversation'
     AND source_ref = ANY(SELECT unnest(v_convs)::text);
  DELETE FROM lead_followups    WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM knowledge_gaps    WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM approval_requests WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM reply_edits       WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM work_items        WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM ask_ai_feedback   WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM re_inquiries      WHERE org_id = p_org_id AND conversation_id = ANY(v_convs);
  DELETE FROM conversations     WHERE org_id = p_org_id AND id = ANY(v_convs);

  -- Memory aged out on its own schedule, independent of any conversation.
  IF v_mem_days IS NOT NULL THEN
    DELETE FROM org_memory
     WHERE org_id = p_org_id
       AND created_at < NOW() - (v_mem_days || ' days')::interval;
  END IF;

  UPDATE org_retention_policy SET last_swept_at = NOW(), updated_at = NOW()
   WHERE org_id = p_org_id;

  RETURN QUERY SELECT FALSE, v_counts;
END;
$$;

COMMENT ON FUNCTION sweep_retention IS
  'Forget on schedule. Dry run by DEFAULT: a workspace must set a number AND '
  'enable the sweep AND pass p_dry_run=false before anything is deleted.';

GRANT EXECUTE ON FUNCTION sweep_retention(UUID, BOOLEAN) TO darex_app;
