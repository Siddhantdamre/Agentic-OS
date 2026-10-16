-- Webhook routing for the per-tenant URL `?org_id=<uuid>&token=<secret>` (and
-- `X-Darex-Org-Id` + `?token=`).
--
-- `orgs` is FORCE ROW LEVEL SECURITY (097): a pooled connection that has not
-- set app.current_org_id sees zero rows in it. The webhook route runs before any
-- org is known, so a plain `SELECT ... FROM orgs` there can never match.
-- Measured on a running stack: 4 orgs as owner, 0 visible to darex_app, and the
-- documented per-tenant URL answered HTTP 400 "Cannot resolve organization".
--
-- This SECURITY DEFINER function is the narrow door: it returns the id only when
-- the id and that org's OWN webhook secret match the same active row. It cannot
-- be used to list or read orgs. Idempotent: CREATE OR REPLACE, so it is safe on
-- a database that already has an identical function.

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
    AND p_secret <> ''
    AND meta->>'webhook_secret' = p_secret
  LIMIT 1;
$$;

COMMENT ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) IS
  'Webhook routing for the ?org_id=&token= form: returns the org id only when '
  'the id and that org''s own webhook secret both match the same active row.';

REVOKE ALL ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_resolve_by_id_and_secret(UUID, TEXT) TO darex, darex_app;
