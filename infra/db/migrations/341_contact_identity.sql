-- 041: one person, however many ways they contact you.
--
-- WHY
-- Measured: 710 conversations, 710 distinct contacts. `contact_id` is a raw
-- TEXT handle — a phone number spelled however the channel happened to spell
-- it — copied onto every conversation row. So the same human is a different
-- stranger every time they write:
--
--   the agent re-asks what it was told last week
--   "have we spoken before?" cannot be answered
--   the follow-up agent counts one person as several quiet leads
--   AN ERASURE REQUEST CANNOT BE HONOURED, because you cannot erase somebody
--     you cannot identify
--
-- That last one is why this is not a nice-to-have. Migration 038 gave erasure
-- a routine; it could only ever erase the conversations sharing one exact
-- spelling of a handle. A person who wrote from +919799992973 and later from
-- 09799992973 was two subjects, and erasing one left the other.
--
-- ── THE MERGE RULE IS DELIBERATELY TIMID ──────────────────────────────────
-- The failure modes are not symmetric. Under-merging costs context: the agent
-- forgets and looks foolish. Over-merging shows one customer another
-- customer's budget, address and complaints — a privacy breach with a person's
-- name on it that cannot be undone.
--
-- So identity is joined ONLY on an identifier the person themselves used, and
-- only when it normalises confidently. No name similarity, no "same surname
-- and locality", no edit distance. The normalisation lives in
-- services/workflows/src/identity/identity.ts with 20 unit tests, most of which
-- assert that two handles must NOT be merged, and the database stores its
-- verdict rather than re-implementing it — two copies of a matching rule drift,
-- and the drift is silent until somebody reads a stranger's history.

-- ── A human ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_persons (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Whatever they are best known as. Never used for matching: a display name
  -- is a label, and matching on labels is how two Sharmas become one.
  display_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE contact_persons IS
  'One row per human. Created only when a handle resolves confidently; a '
  'handle that cannot be placed still gets its own person, because they are '
  'somebody, just not knowably the same somebody as anyone else.';

ALTER TABLE contact_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_persons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_persons_org_isolation ON contact_persons;
CREATE POLICY contact_persons_org_isolation ON contact_persons
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── The handles they use ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_identities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  person_id   UUID NOT NULL REFERENCES contact_persons(id) ON DELETE CASCADE,

  kind        TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'handle')),
  -- The canonical form. Two handles are one person when these match.
  value_norm  TEXT NOT NULL,
  -- Exactly as the channel gave it. Kept for display and for audit: an
  -- operator needs to see the number the way their customer writes it.
  value_raw   TEXT NOT NULL,
  -- False when the handle could not be canonicalised. Such a row matches only
  -- itself and never merges.
  confident   BOOLEAN NOT NULL DEFAULT TRUE,

  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE contact_identities IS
  'Every way one person has contacted this workspace. value_norm is the '
  'canonical form from identity.ts; value_raw is what the channel sent. '
  'PERSONAL DATA: erased with the person, see erase_data_subject.';

-- ONE ROW PER SPELLING, NOT PER PERSON.
--
-- The first version made this unique on value_norm, which conflated two
-- different questions: "which spelling is this" and "which person is this".
-- Four renderings of one number share a value_norm, so the second, third and
-- fourth hit ON CONFLICT and were never stored at all -- and erase_person,
-- which walks the rows to find every handle a person uses, could only ever
-- find one. Erasing a customer removed a quarter of them. Caught by
-- check-identity.js: "it erased across all four handles -- 1".
--
-- It also merged two anonymous senders: both "unknown" handles normalise to
-- the same unplaceable value, the TypeScript layer deliberately kept them
-- apart, and this index put them back together -- the exact privacy failure
-- the module is written to prevent, reintroduced one layer down.
-- PARTIAL: unique only among handles that could be PLACED.
--
-- An unplaceable handle must be allowed to repeat, because the same literal
-- string does not imply the same human. Two senders a channel both labelled
-- "unknown" write the identical value_raw and are two different people; a
-- total unique index here merged them, and each would have read the other's
-- history. Caught by check-identity.js on the second run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_identities_raw
  ON contact_identities (org_id, kind, value_raw) WHERE confident;

-- The person-level grouping. NOT unique: many spellings map to one person,
-- which is the entire point. resolve_contact_person reads this to find the
-- person behind a new spelling.
CREATE INDEX IF NOT EXISTS idx_contact_identities_norm
  ON contact_identities (org_id, kind, value_norm) WHERE confident;

CREATE INDEX IF NOT EXISTS idx_contact_identities_person
  ON contact_identities (person_id);

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_identities_org_isolation ON contact_identities;
CREATE POLICY contact_identities_org_isolation ON contact_identities
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- ── The link from a conversation to a human ─────────────────────────────────
-- Nullable, and stays nullable. Backfilling every historical conversation may
-- leave some unresolvable, and a NOT NULL here would mean either inventing a
-- person for them or refusing to store the conversation. Both are worse than
-- an honest null.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS person_id UUID
  REFERENCES contact_persons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_person
  ON conversations (org_id, person_id);

-- ── Resolve a handle to a person ────────────────────────────────────────────
-- The caller has already normalised, because the normalisation rules are
-- tested in TypeScript and must not exist twice. This function's job is the
-- part only the database can do safely: find-or-create, atomically, so two
-- simultaneous messages from the same number cannot create two people.
DROP FUNCTION IF EXISTS resolve_contact_person(UUID, TEXT, TEXT, TEXT, BOOLEAN, TEXT);
CREATE FUNCTION resolve_contact_person(
  p_org_id     UUID,
  p_kind       TEXT,
  p_value_norm TEXT,
  p_value_raw  TEXT,
  p_confident  BOOLEAN DEFAULT TRUE,
  p_display    TEXT DEFAULT ''
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person UUID;
BEGIN
  IF p_org_id IS NULL OR COALESCE(TRIM(p_value_norm), '') = '' THEN
    RAISE EXCEPTION 'resolve_contact_person: org and normalised value are required';
  END IF;

  -- AN UNPLACEABLE HANDLE NEVER JOINS ANYBODY.
  --
  -- Not by normalised value, and not even by an identical raw string. "unknown"
  -- is what a channel writes when it does not know who sent something, so two
  -- of them are two humans -- and claiming otherwise hands each of them the
  -- other's conversations. It always becomes a new person.
  IF NOT COALESCE(p_confident, TRUE) THEN
    INSERT INTO contact_persons (org_id, display_name)
    VALUES (p_org_id, COALESCE(NULLIF(TRIM(p_display), ''), p_value_raw))
    RETURNING id INTO v_person;

    INSERT INTO contact_identities (org_id, person_id, kind, value_norm, value_raw, confident)
    VALUES (p_org_id, v_person, p_kind, p_value_norm, p_value_raw, FALSE);

    RETURN v_person;
  END IF;

  -- An exact spelling seen before is the same person, always.
  SELECT person_id INTO v_person
    FROM contact_identities
   WHERE org_id = p_org_id AND kind = p_kind AND value_raw = p_value_raw AND confident;

  IF v_person IS NOT NULL THEN
    UPDATE contact_identities SET last_seen = NOW()
     WHERE org_id = p_org_id AND kind = p_kind AND value_raw = p_value_raw AND confident;
    RETURN v_person;
  END IF;

  -- A NEW spelling joins an existing person only when it normalises
  -- CONFIDENTLY to one already seen. An unplaceable handle never groups: two
  -- senders a channel both labelled "unknown" are two humans, and treating
  -- them as one would let each read the other's history.
  IF COALESCE(p_confident, TRUE) THEN
    SELECT person_id INTO v_person
      FROM contact_identities
     WHERE org_id = p_org_id AND kind = p_kind
       AND value_norm = p_value_norm AND confident
     LIMIT 1;

    IF v_person IS NOT NULL THEN
      INSERT INTO contact_identities (org_id, person_id, kind, value_norm, value_raw, confident)
      VALUES (p_org_id, v_person, p_kind, p_value_norm, p_value_raw, TRUE)
      ON CONFLICT (org_id, kind, value_raw) WHERE confident DO UPDATE SET last_seen = NOW();
      RETURN v_person;
    END IF;
  END IF;

  INSERT INTO contact_persons (org_id, display_name)
  VALUES (p_org_id, COALESCE(NULLIF(TRIM(p_display), ''), p_value_raw))
  RETURNING id INTO v_person;

  -- ON CONFLICT closes the race: if another connection created the same
  -- identity between the SELECT above and here, adopt THEIR person and discard
  -- the one just made, rather than ending with two people for one number.
  INSERT INTO contact_identities (org_id, person_id, kind, value_norm, value_raw, confident)
  VALUES (p_org_id, v_person, p_kind, p_value_norm, p_value_raw, COALESCE(p_confident, TRUE))
  -- The WHERE is REQUIRED, not decoration: uq_contact_identities_raw is a
  -- PARTIAL index, and Postgres will not infer a partial index unless the
  -- inference clause repeats its predicate. Omitting it fails at runtime with
  -- "no unique or exclusion constraint matching the ON CONFLICT
  -- specification" -- the second time in this schema that a partial unique
  -- index has broken an upsert (see migration 039).
  ON CONFLICT (org_id, kind, value_raw) WHERE confident DO UPDATE SET last_seen = NOW()
  RETURNING person_id INTO v_person;

  DELETE FROM contact_persons cp
   WHERE cp.id <> v_person
     AND cp.org_id = p_org_id
     AND NOT EXISTS (SELECT 1 FROM contact_identities ci WHERE ci.person_id = cp.id)
     AND cp.created_at > NOW() - INTERVAL '1 minute';

  RETURN v_person;
END;
$$;

COMMENT ON FUNCTION resolve_contact_person IS
  'Find or create the person behind a NORMALISED handle. Normalisation is done '
  'by identity.ts; this only does the find-or-create atomically so two '
  'simultaneous messages cannot create two people for one number.';

-- ── Every handle a person uses ──────────────────────────────────────────────
-- What erasure needs: erasing "a phone number" is not erasing a person.
DROP FUNCTION IF EXISTS person_handles(UUID, UUID);
CREATE FUNCTION person_handles(p_org_id UUID, p_person_id UUID)
RETURNS TABLE (kind TEXT, value_norm TEXT, value_raw TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ci.kind, ci.value_norm, ci.value_raw
    FROM contact_identities ci
   WHERE ci.org_id = p_org_id AND ci.person_id = p_person_id;
$$;

GRANT EXECUTE ON FUNCTION resolve_contact_person(UUID, TEXT, TEXT, TEXT, BOOLEAN, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION person_handles(UUID, UUID) TO darex_app;

-- ── Erasure, by PERSON ──────────────────────────────────────────────────────
--
-- Migration 038 gave erasure a routine keyed on one exact spelling of a
-- handle. That was the best available then and it was not enough: a customer
-- who wrote from +919799992973 in March and 09799992973 in July was two
-- subjects, and honouring their request erased half of them. The half left
-- behind still held their messages, and the agent would still have answered
-- from what it learned there.
--
-- This resolves the handle to the PERSON first, then erases every conversation
-- belonging to EVERY handle that person has ever used. It reuses
-- erase_data_subject per handle rather than duplicating the deletion order —
-- that ordering is load-bearing (the ON DELETE SET NULL rows and the derived
-- memory must go before the conversation, or they are stranded) and having it
-- written twice is how one copy quietly stops matching the other.
DROP FUNCTION IF EXISTS erase_person(UUID, TEXT, TEXT, UUID);
CREATE FUNCTION erase_person(
  p_org_id       UUID,
  -- Any handle the person is known by. The rest are found from it.
  p_any_handle   TEXT,
  p_reason       TEXT DEFAULT 'data_subject_request',
  p_requested_by UUID DEFAULT NULL
) RETURNS TABLE (handles_erased INT, receipts UUID[], erased JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_person   UUID;
  v_handle   RECORD;
  v_receipts UUID[] := ARRAY[]::UUID[];
  v_total    JSONB := '{}'::jsonb;
  v_one      RECORD;
  v_n        INT := 0;
  k          TEXT;
BEGIN
  IF p_org_id IS NULL OR COALESCE(TRIM(p_any_handle), '') = '' THEN
    RAISE EXCEPTION 'erase_person: org and a handle are required';
  END IF;

  -- Which person is this? Matched on the RAW spelling as stored, or on the
  -- normalised form if the caller already normalised it.
  SELECT ci.person_id INTO v_person
    FROM contact_identities ci
   WHERE ci.org_id = p_org_id
     AND (ci.value_raw = TRIM(p_any_handle) OR ci.value_norm = TRIM(p_any_handle))
   LIMIT 1;

  IF v_person IS NULL THEN
    -- Not a resolved person. Fall back to erasing that one handle, which is
    -- exactly what 038 did — better than refusing, and honest about its limit.
    FOR v_one IN SELECT * FROM erase_data_subject(p_org_id, TRIM(p_any_handle), p_reason, p_requested_by)
    LOOP
      v_receipts := array_append(v_receipts, v_one.receipt_id);
      v_total := v_one.erased;
      v_n := 1;
    END LOOP;
    RETURN QUERY SELECT v_n, v_receipts, v_total;
    RETURN;
  END IF;

  -- Every spelling this person has ever used.
  FOR v_handle IN
    SELECT ci.value_raw FROM contact_identities ci
     WHERE ci.org_id = p_org_id AND ci.person_id = v_person
  LOOP
    FOR v_one IN SELECT * FROM erase_data_subject(p_org_id, v_handle.value_raw, p_reason, p_requested_by)
    LOOP
      v_receipts := array_append(v_receipts, v_one.receipt_id);
      -- Sum the per-table counts across handles, so the receipt totals reflect
      -- the person rather than whichever handle happened to be erased last.
      FOR k IN SELECT jsonb_object_keys(v_one.erased)
      LOOP
        v_total := jsonb_set(
          v_total, ARRAY[k],
          to_jsonb(COALESCE((v_total ->> k)::bigint, 0) + COALESCE((v_one.erased ->> k)::bigint, 0)),
          true);
      END LOOP;
    END LOOP;
    v_n := v_n + 1;
  END LOOP;

  -- The identities themselves are personal data — value_raw IS the phone
  -- number. Deleting the person cascades them. Done LAST, so a failure part
  -- way through leaves the person resolvable and the erasure re-runnable
  -- rather than orphaning conversations nobody can find again.
  DELETE FROM contact_persons WHERE id = v_person AND org_id = p_org_id;
  v_total := jsonb_set(v_total, ARRAY['contact_identities'], to_jsonb(v_n), true);

  RETURN QUERY SELECT v_n, v_receipts, v_total;
END;
$$;

COMMENT ON FUNCTION erase_person IS
  'Erase a human across EVERY handle they have used, not just the one you were '
  'given. Falls back to single-handle erasure when the handle resolves to no '
  'person. The identities are deleted last so a partial failure stays '
  're-runnable.';

GRANT EXECUTE ON FUNCTION erase_person(UUID, TEXT, TEXT, UUID) TO darex_app;
