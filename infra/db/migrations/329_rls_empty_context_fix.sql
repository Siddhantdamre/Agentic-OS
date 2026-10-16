-- 029: an empty org context must mean "see nothing", not "throw".
--
-- THE BUG
-- Every org-isolation policy in this database — 43 of them — casts the tenant
-- GUC straight to uuid:
--
--   (org_id = (current_setting('app.current_org_id'::text, true))::uuid)
--
-- The `true` makes current_setting return NULL for a GUC that was never set,
-- and that case works. But apps/dashboard/lib/db.ts runs `RESET
-- app.current_org_id` when it releases a pooled client, and after a RESET the
-- setting is the EMPTY STRING, not NULL:
--
--   SELECT set_config('app.current_org_id', '<uuid>', false);
--   RESET app.current_org_id;
--   SELECT current_setting('app.current_org_id', true);   -- ''  (not NULL)
--
-- and ''::uuid raises. Measured on the live database, as darex_app:
--
--   conversations -> ERROR: invalid input syntax for type uuid: ""
--   org_memory    -> ERROR: invalid input syntax for type uuid: ""
--   orgs          -> ERROR: invalid input syntax for type uuid: ""
--
-- So any query on a tenant table, on a pooled connection that a scoped request
-- previously used and released, fails with a type error instead of returning
-- zero rows. Every unscoped pool user is exposed to it — the webhook routing
-- paths most of all, since they deliberately run without an org context. The
-- symptom is an intermittent 500 that gets more likely the busier the system
-- is, because connection reuse gets more likely, and that reads like a load
-- problem rather than a one-character bug.
--
-- Found while adding the orgs policy in 028; the flaw is older than that and
-- affects every table.
--
-- THE FIX
-- NULLIF the empty string before the cast. NULL then propagates through the
-- comparison, the row does not match, and the query returns nothing — which is
-- the correct fail-closed answer for "no tenant context". Isolation is
-- unchanged: an empty context matched no rows before (it errored) and matches
-- no rows now.
--
-- Applied mechanically. There are exactly two expression shapes in the
-- database (`id = ...` for orgs, `org_id = ...` for everything else) and both
-- contain the identical cast substring, so this is a textual substitution over
-- pg_policies rather than 43 hand-written statements that could drift.

DO $migration$
DECLARE
  r RECORD;
  old_expr CONSTANT TEXT := '(current_setting(''app.current_org_id''::text, true))::uuid';
  new_expr CONSTANT TEXT := '(NULLIF(current_setting(''app.current_org_id''::text, true), ''''::text))::uuid';
  new_qual TEXT;
  new_check TEXT;
  n INT := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check, roles
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (COALESCE(qual, '') LIKE '%app.current_org_id%'
        OR COALESCE(with_check, '') LIKE '%app.current_org_id%')
      -- Idempotent: skip anything already carrying the guard.
      AND COALESCE(qual, '') NOT LIKE '%NULLIF%'
      AND COALESCE(with_check, '') NOT LIKE '%NULLIF%'
  LOOP
    new_qual  := replace(COALESCE(r.qual, ''), old_expr, new_expr);
    new_check := replace(COALESCE(r.with_check, ''), old_expr, new_expr);

    -- Refuse to proceed on an expression this does not recognise rather than
    -- silently recreating a policy with the bug still in it.
    IF r.qual IS NOT NULL AND new_qual = r.qual THEN
      RAISE EXCEPTION 'policy %.% has an unrecognised USING expression: %',
        r.tablename, r.policyname, r.qual;
    END IF;

    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);

    IF r.with_check IS NULL THEN
      EXECUTE format('CREATE POLICY %I ON %I.%I FOR %s TO %s USING (%s)',
        r.policyname, r.schemaname, r.tablename, r.cmd,
        array_to_string(r.roles, ', '), new_qual);
    ELSE
      EXECUTE format('CREATE POLICY %I ON %I.%I FOR %s TO %s USING (%s) WITH CHECK (%s)',
        r.policyname, r.schemaname, r.tablename, r.cmd,
        array_to_string(r.roles, ', '), new_qual, new_check);
    END IF;

    n := n + 1;
  END LOOP;

  RAISE NOTICE '029: rewrote % policies to tolerate an empty org context', n;
END;
$migration$;

-- Proof, in the migration itself: after this runs, no policy may still cast the
-- GUC without the NULLIF guard. If one does, the migration fails rather than
-- reporting success over a half-applied fix.
DO $verify$
DECLARE
  leftover INT;
BEGIN
  SELECT COUNT(*) INTO leftover
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (COALESCE(qual, '') LIKE '%app.current_org_id%'
      OR COALESCE(with_check, '') LIKE '%app.current_org_id%')
    AND (COALESCE(qual, '') NOT LIKE '%NULLIF%'
      AND COALESCE(with_check, '') NOT LIKE '%NULLIF%');

  IF leftover > 0 THEN
    RAISE EXCEPTION '029 incomplete: % policies still cast the org GUC unguarded', leftover;
  END IF;
END;
$verify$;
