-- 039: leads that went quiet — the first work the agent does unasked.
--
-- WHY
-- Every entry point into this system is an inbound message or a human pressing
-- a button. So the agent can only answer, and a lead who stopped replying will
-- never speak again. That work — following up with someone who went quiet — is
-- not difficult. It is simply nobody's job, never urgent, and therefore never
-- done. It is also, for a broker or a clinic, most of the lost revenue.
--
-- Measured on this deployment before building it: 716 recorded agent actions,
-- every single one `reply_sent`. The agent had never once acted first.
--
-- ── WHAT THIS TABLE IS FOR ────────────────────────────────────────────────
-- Not "which leads are quiet" — that is a query over conversations, and
-- storing it would go stale the moment somebody replied. This is the record of
-- what the agent DID about it, and whether it worked.
--
-- The second half matters more than the first. A follow-up that is sent and
-- never measured is indistinguishable from spam, including to the business
-- paying for it. `replied_at` is what turns "we sent 40 messages" into "9 of
-- 40 people replied who would otherwise never have been contacted", which is
-- the only sentence that justifies leaving the feature switched on.
--
-- ── WHY IT RECORDS WHAT IT DECIDED NOT TO SEND ────────────────────────────
-- Skipped rows are kept, with the reason. An operator's first question is
-- never "who did you contact" — it is "did you message the man who complained
-- about his refund?". Being able to answer "no, and here is the row where it
-- was refused, and why" is what makes the feature trustworthy enough to leave
-- on. A ledger of only the sends cannot answer the question that matters.

CREATE TABLE IF NOT EXISTS lead_followups (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NOT NULL: a follow-up that is not about a conversation is meaningless,
  -- and a nullable key cannot back the ON CONFLICT below (Postgres will not
  -- infer a PARTIAL unique index without repeating its predicate).
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  employee_id     UUID,

  -- 1 or 2. Two is a follow-up; three is harassment.
  nudge_number    INTEGER NOT NULL DEFAULT 1 CHECK (nudge_number BETWEEN 1 AND 5),
  -- How long they had been silent when this was decided. Kept so a rate can
  -- later be broken down by staleness without recomputing history.
  quiet_days      INTEGER NOT NULL DEFAULT 0,

  -- proposed   drafted, waiting for a human (autonomy says ask)
  -- sent       actually went out
  -- skipped    deliberately not sent, see skip_reason
  -- suppressed shadow mode or dry run: drafted, deliberately never sent
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed', 'sent', 'skipped', 'suppressed')),
  skip_reason     TEXT,

  -- What the agent would say. Kept even when skipped, so an operator can see
  -- the judgement rather than being asked to trust it.
  draft           TEXT NOT NULL DEFAULT '',

  sent_at         TIMESTAMPTZ,
  -- THE outcome. Set only by a customer message that arrives strictly AFTER
  -- sent_at — a reply that predates the nudge was not caused by it, and
  -- crediting it would flatter the one number that decides whether a business
  -- keeps this switched on.
  replied_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE lead_followups IS
  'What the agent did about leads that went quiet, including the ones it '
  'deliberately did not contact and why. replied_at is only ever set from a '
  'customer message strictly after sent_at.';

-- One row per (conversation, nudge). The engine can run every hour without
-- ever producing a second follow-up for the same lead at the same stage.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_followups_conv_nudge
  ON lead_followups (conversation_id, nudge_number);

CREATE INDEX IF NOT EXISTS idx_lead_followups_org_recent
  ON lead_followups (org_id, created_at DESC);

-- The outcome sweep looks for sends that have not yet been answered.
CREATE INDEX IF NOT EXISTS idx_lead_followups_awaiting
  ON lead_followups (org_id, sent_at)
  WHERE status = 'sent' AND replied_at IS NULL;

ALTER TABLE lead_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_followups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_followups_org_isolation ON lead_followups;
CREATE POLICY lead_followups_org_isolation ON lead_followups
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
-- NULLIF guards the empty-string GUC. Migration 029 exists because 43 policies
-- written without it threw on every pooled connection after a RESET.

-- ── Record one decision ─────────────────────────────────────────────────────
-- Write-only door for the follow-up runner, which processes many tenants in
-- one pass and so cannot hold a single org context. It cannot read another
-- tenant's rows, which is what makes a SECURITY DEFINER acceptable here.
DROP FUNCTION IF EXISTS record_lead_followup(UUID, UUID, UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT);
CREATE FUNCTION record_lead_followup(
  p_org_id      UUID,
  p_conv_id     UUID,
  p_employee_id UUID,
  p_nudge       INTEGER,
  p_quiet_days  INTEGER,
  p_status      TEXT,
  p_skip_reason TEXT,
  p_draft       TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = p_conv_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'record_lead_followup: conversation does not belong to this workspace';
  END IF;

  INSERT INTO lead_followups AS f
    (org_id, conversation_id, employee_id, nudge_number, quiet_days, status, skip_reason, draft, sent_at)
  VALUES
    (p_org_id, p_conv_id, p_employee_id, COALESCE(p_nudge, 1), COALESCE(p_quiet_days, 0),
     p_status, p_skip_reason, COALESCE(p_draft, ''),
     CASE WHEN p_status = 'sent' THEN NOW() ELSE NULL END)
  ON CONFLICT (conversation_id, nudge_number) DO UPDATE SET
    -- Re-evaluating a lead may change the verdict (a customer replies, a
    -- complaint arrives). The decision is refreshed, but a send is NEVER
    -- unsent and sent_at is never moved: that timestamp is the baseline the
    -- reply outcome is measured against, and rewriting it would let a nudge
    -- take credit for a reply that came before it.
    status      = CASE WHEN f.status = 'sent' THEN f.status ELSE EXCLUDED.status END,
    skip_reason = CASE WHEN f.status = 'sent' THEN f.skip_reason ELSE EXCLUDED.skip_reason END,
    draft       = CASE WHEN f.status = 'sent' THEN f.draft ELSE EXCLUDED.draft END,
    quiet_days  = EXCLUDED.quiet_days,
    -- STAMP IT ON THE TRANSITION TO SENT, not only on insert.
    --
    -- The first version set sent_at in the VALUES clause and never here, so a
    -- row that was written as 'proposed' on one run and became 'sent' on the
    -- next kept sent_at NULL. That one omission broke both halves of the
    -- feature at once, silently:
    --
    --   settle_lead_followups compares `msg.created_at > sent_at`, which is
    --   NULL for such a row, so the follow-up could NEVER be marked answered
    --   and the reply rate — the only number justifying the feature — would
    --   have sat at zero forever;
    --
    --   the candidate query takes last_nudge_at as MAX(sent_at), so the
    --   cooldown was blind and the SAME PERSON was nudged again on the next
    --   run, escalating through nudge 2 and 3 within minutes. Observed
    --   exactly that before this was fixed.
    --
    -- COALESCE keeps the original: a send is stamped once and the timestamp
    -- never moves, because it is the baseline the reply is measured against.
    sent_at     = COALESCE(f.sent_at,
                    CASE WHEN EXCLUDED.status = 'sent' THEN NOW() ELSE NULL END),
    updated_at  = NOW()
  RETURNING f.id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_lead_followup IS
  'Upsert one follow-up decision. A row already marked sent is never rewritten '
  'and sent_at never moves — it is the baseline the reply is measured against.';

-- ── Did it work? ────────────────────────────────────────────────────────────
-- Looks for a customer message that arrived strictly after the nudge. Run as a
-- sweep rather than on the inbound path, so a missed run costs resolution and
-- never corrupts the series.
DROP FUNCTION IF EXISTS settle_lead_followups(UUID);
CREATE FUNCTION settle_lead_followups(p_org_id UUID)
RETURNS TABLE (settled INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE lead_followups f
     SET replied_at = m.first_reply,
         updated_at = NOW()
    FROM (
      SELECT lf.id,
             MIN(msg.created_at) AS first_reply
        FROM lead_followups lf
        JOIN messages msg
          ON msg.conversation_id = lf.conversation_id
         AND msg.role = 'user'
         -- STRICTLY after. A reply in the same instant, or earlier, was not
         -- caused by the follow-up.
         AND msg.created_at > lf.sent_at
       WHERE lf.org_id = p_org_id
         AND lf.status = 'sent'
         AND lf.replied_at IS NULL
       GROUP BY lf.id
    ) m
   WHERE f.id = m.id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT v_n;
END;
$$;

COMMENT ON FUNCTION settle_lead_followups IS
  'Mark follow-ups answered where a customer message arrived strictly after '
  'the nudge. Idempotent: only rows with replied_at IS NULL are considered.';

GRANT EXECUTE ON FUNCTION record_lead_followup(UUID, UUID, UUID, INTEGER, INTEGER, TEXT, TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION settle_lead_followups(UUID) TO darex_app;
