-------------------------------------------------------------------------------
-- Close the tenant-writable global tables (SEC-T01, SEC-T02, SEC-T05).
--
--   platform_send_counters  no RLS, full S/I/U/D to darex_app: any tenant
--                           session could zero or inflate the platform-wide
--                           send ceiling. Writes now go through
--                           platform_send_counter_bump() only.
--   pack_entity_schemas     `write_all USING (true)`: any tenant rewrote pack
--   predicate_defs          schemas / the predicate vocabulary. Catalogs are
--                           seeded by migrations (superuser); darex_app reads.
--   rera_cache              `write_all USING (true)`: cross-tenant cache
--                           poisoning. Writes go through rera_cache_put(),
--                           which only accepts the official RERA hosts and a
--                           bounded payload.
--   orgs INSERT             `WITH CHECK (true)`: a tenant session could create
--                           orgs with any plan/status. New orgs go through
--                           auth_create_org(), which pins plan=free and
--                           status=provisioning.
--
-- Idempotent. File: infra/db/migrations/201_global_table_boundaries.sql
-------------------------------------------------------------------------------

-- platform_send_counters ------------------------------------------------------
ALTER TABLE platform_send_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_send_counters FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_send_counters FROM PUBLIC, darex_app;

CREATE OR REPLACE FUNCTION platform_send_counter_bump()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO platform_send_counters (minute_bucket, send_count)
  VALUES (date_trunc('minute', NOW()), 1)
  ON CONFLICT (minute_bucket)
  DO UPDATE SET send_count = platform_send_counters.send_count + 1
  RETURNING send_count INTO n;
  -- Keep the table small; only the current minute matters.
  DELETE FROM platform_send_counters WHERE minute_bucket < NOW() - INTERVAL '1 hour';
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION platform_send_counter_bump() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_send_counter_bump() TO darex_app;

-- pack_entity_schemas ---------------------------------------------------------
DROP POLICY IF EXISTS pack_entity_schemas_write_all ON pack_entity_schemas;
REVOKE INSERT, UPDATE, DELETE ON pack_entity_schemas FROM PUBLIC, darex_app;
GRANT SELECT ON pack_entity_schemas TO darex_app;

-- predicate_defs --------------------------------------------------------------
DROP POLICY IF EXISTS predicate_defs_write_all ON predicate_defs;
REVOKE INSERT, UPDATE, DELETE ON predicate_defs FROM PUBLIC, darex_app;
GRANT SELECT ON predicate_defs TO darex_app;

-- rera_cache ------------------------------------------------------------------
DROP POLICY IF EXISTS rera_cache_write_all ON rera_cache;
REVOKE INSERT, UPDATE, DELETE ON rera_cache FROM PUBLIC, darex_app;
GRANT SELECT ON rera_cache TO darex_app;

CREATE OR REPLACE FUNCTION rera_cache_put(
  p_rera_id text,
  p_market text,
  p_url text,
  p_retrieved_at timestamptz,
  p_expires_at timestamptz,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_url !~ '^https://(rera\.gov\.in|maharerait\.mahaonline\.gov\.in)/' THEN
    RAISE EXCEPTION 'rera_cache_put: url must be an official RERA host';
  END IF;
  IF length(p_rera_id) > 128 OR length(p_market) > 16 THEN
    RAISE EXCEPTION 'rera_cache_put: id or market too long';
  END IF;
  IF octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'rera_cache_put: payload too large';
  END IF;
  IF p_expires_at > NOW() + INTERVAL '30 days' THEN
    RAISE EXCEPTION 'rera_cache_put: expires_at too far in the future';
  END IF;
  INSERT INTO rera_cache (rera_id, market, url, retrieved_at, expires_at, payload)
  VALUES (p_rera_id, p_market, p_url, p_retrieved_at, p_expires_at, p_payload)
  ON CONFLICT (rera_id, market) DO UPDATE SET
    url = EXCLUDED.url,
    retrieved_at = EXCLUDED.retrieved_at,
    expires_at = EXCLUDED.expires_at,
    payload = EXCLUDED.payload,
    updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION rera_cache_put(text, text, text, timestamptz, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rera_cache_put(text, text, text, timestamptz, timestamptz, jsonb) TO darex_app;

-- orgs INSERT -----------------------------------------------------------------
DROP POLICY IF EXISTS orgs_tenant_insert ON orgs;
REVOKE INSERT ON orgs FROM darex_app;

CREATE OR REPLACE FUNCTION auth_create_org(p_id uuid, p_name text, p_slug text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_id IS NULL OR coalesce(btrim(p_name), '') = '' OR coalesce(btrim(p_slug), '') = '' THEN
    RAISE EXCEPTION 'auth_create_org: id, name and slug are required';
  END IF;
  IF length(p_name) > 200 OR length(p_slug) > 100 THEN
    RAISE EXCEPTION 'auth_create_org: name or slug too long';
  END IF;
  INSERT INTO orgs (id, name, slug, plan, status)
  VALUES (p_id, p_name, p_slug, 'free', 'provisioning');
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION auth_create_org(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_create_org(uuid, text, text) TO darex_app;
