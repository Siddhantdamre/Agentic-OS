-- 028: put the tenant REGISTRY behind RLS, like every other tenant table.
--
-- WHAT WAS WRONG
-- conversations, messages, org_memory, work_items, reply_edits and
-- knowledge_gaps all have RLS enabled AND forced, each with an org_id
-- isolation policy. `orgs` — the table that defines what a tenant IS — had
-- neither, and no policy at all. Measured, not assumed:
--
--   SET ROLE darex_app;                        -- what the dashboard runs as
--   SELECT COUNT(*) FROM orgs;                 -- no org context set
--   -> 58
--
-- The least-privilege application role could enumerate every customer on the
-- deployment — name, slug, plan, status — with no session and no org context.
-- The application's own queries filter by the session org, so this is a
-- defence-in-depth failure rather than a demonstrated leak through the UI. It
-- is still the first thing any prospect's security reviewer will check, and
-- "every tenant table is protected except the tenant list" is not an answer.
--
-- WHY IT WAS LEFT OPEN, AND WHY THAT IS ALREADY MOSTLY SOLVED
-- Several flows touch `orgs` BEFORE any org context exists — resolving which
-- org an inbound webhook belongs to is precisely the question being asked, and
-- at signup the row being written is what establishes the context. Migrations
-- 009 and 010 already built the right answer for most of them:
--
--   resolve_org_by_webhook_secret(text)   secret  -> org id
--   resolve_active_org(uuid)              org id  -> org id, if active
--   single_active_org_id()                the org id when there is exactly one
--
-- all SECURITY DEFINER, all granted to darex_app, all returning a single id
-- and never an org attribute. They were being called with a raw-SQL `catch`
-- fallback behind them, which quietly did the unscoped read the function
-- existed to prevent; those fallbacks are removed in this change.
--
-- This migration adds only the two doors that did not already exist, and then
-- closes the wall. The difference between a hole and a door is that a door is
-- named, granted deliberately, and returns one row.

-- ── The policy ─────────────────────────────────────────────────────────────
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
-- FORCE so the table owner is bound by it too. Without FORCE, RLS is skipped
-- for the owner and a maintenance script silently sees everything — which is
-- how a policy passes review and protects nothing.
--
-- The SECURITY DEFINER resolvers still work because they execute as `darex`,
-- which is a superuser, and superusers bypass RLS regardless of FORCE. That is
-- load-bearing: if this deployment ever moves the table to a non-superuser
-- owner, those functions need `SET row_security = off` or the webhook paths go
-- dark. Written down because it is invisible until it breaks.
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orgs_org_isolation ON orgs;
CREATE POLICY orgs_org_isolation ON orgs
  USING (id = (current_setting('app.current_org_id', true))::uuid)
  WITH CHECK (id = (current_setting('app.current_org_id', true))::uuid);

COMMENT ON POLICY orgs_org_isolation ON orgs IS
  'A session sees exactly its own org row. Pre-context flows (signup, webhook '
  'routing) go through the SECURITY DEFINER resolvers, not around the policy.';

-- ── New door 1: create an org during signup ────────────────────────────────
-- The WITH CHECK above would reject this insert: at signup time there is no
-- org context, and there cannot be — the row being written is what creates it.
CREATE OR REPLACE FUNCTION org_provision(p_name TEXT, p_slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'org name is required';
  END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' THEN
    RAISE EXCEPTION 'org slug is required';
  END IF;

  -- 'active', not 'provisioning'. Nothing in the codebase ever completes a
  -- provisioning step, and webhook resolution requires status='active', so a
  -- tenant created any other way silently cannot receive inbound messages.
  INSERT INTO orgs (name, slug, plan, status)
  VALUES (btrim(p_name), btrim(p_slug), 'free', 'active')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION org_provision(TEXT, TEXT) IS
  'Signup only: create a new org before any org context exists. Returns the '
  'new id and nothing else — it cannot be used to read existing rows.';

-- ── New door 2: confirm an org id against that org's OWN webhook secret ────
-- The `?org_id=&token=` form. Both must match the same row, which is what
-- stops the shared global webhook secret from being usable to target any org
-- by guessing ids. Returns the id only when the pair validates.
CREATE OR REPLACE FUNCTION org_resolve_by_id_and_secret(p_org UUID, p_secret TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM orgs
  WHERE id = p_org
    AND status = 'active'
    AND p_secret IS NOT NULL
    AND meta->>'webhook_secret' = p_secret
  LIMIT 1;
$$;

COMMENT ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) IS
  'Webhook routing for the ?org_id=&token= form: returns the org id only when '
  'the id and that org''s own webhook secret both match the same row.';

-- ── Grants ─────────────────────────────────────────────────────────────────
-- Narrow and explicit. The other three resolvers are already granted by
-- migrations 009 and 010 and are deliberately reused, not duplicated.
REVOKE ALL ON FUNCTION org_provision(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_provision(TEXT, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) TO darex, darex_app;
