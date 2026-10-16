-------------------------------------------------------------------------------
-- 108_neutralize_single_org_resolvers.sql
-- Cross-tenant guess helpers from 010 must never return a row. Unmapped
-- inbound traffic fails honestly instead of landing in the only active org.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_single_org_whatsapp_channel()
RETURNS TABLE (id UUID, org_id UUID, meta JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT NULL::uuid AS id, NULL::uuid AS org_id, NULL::jsonb AS meta
  WHERE false;
$$;

CREATE OR REPLACE FUNCTION single_active_org_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT NULL::uuid WHERE false;
$$;

COMMENT ON FUNCTION resolve_single_org_whatsapp_channel() IS
  'Deprecated: always empty. Never guess a WhatsApp channel across tenants.';
COMMENT ON FUNCTION single_active_org_id() IS
  'Deprecated: always NULL. Never fall back to the only active org.';
