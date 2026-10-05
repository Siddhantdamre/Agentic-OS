-- 207: model-written SQL runs as a role that cannot read credentials, re-point
--      row-level security, or call the SECURITY DEFINER doors.
--
-- WHAT WAS WRONG
-- `database_query` (services/workflows/src/tools/database.ts) runs SQL a MODEL
-- wrote, and the model has read inbound customer messages. The tool is in the
-- always-allowed core set (tool-gate.ts), so no approval stands in front of it.
-- Until now it ran as the full application role behind a keyword filter plus a
-- READ ONLY transaction. Measured against the schema from migrations 001-206,
-- through the compiled tool, acting as one tenant, with fake secrets:
--
--   SELECT * FROM auth_lookup_user_by_email('<another tenant owner>')
--       -> that tenant's email AND password hash (a SECURITY DEFINER helper that
--          bypasses RLS by design; the application role may EXECUTE it)
--   SELECT email, password_hash FROM users
--   SELECT meta->>'webhook_secret' FROM orgs
--   SELECT meta FROM channels                         (channel access token)
--   SELECT query_to_xml('select password_hash from users', true, true, '')
--   SELECT email FROM users ORDER BY password_hash    (ordering side channel)
--
-- READ ONLY and the keyword filter did stop writes, set_config and pg_* calls.
-- They cannot stop credentials leaving through a tenant's own reply: for a
-- lexical filter `SELECT *` names no column, and a helper function's name looks
-- like any other.
--
-- THE FIX: A DEDICATED ROLE, ENTERED FOR THE LIFE OF ONE TRANSACTION
-- `darex_sql_reader` is NOLOGIN. The tool runs `SET LOCAL ROLE darex_sql_reader`
-- inside its READ ONLY transaction, so the role vanishes at ROLLBACK and the
-- pooled connection is the application role again for the next tenant. The role:
--
--   * may SELECT every column of every TENANT table (one with an org_id column,
--     plus `orgs`) EXCEPT the credential columns listed below. Column privileges
--     apply to every reference, so `WHERE password_hash LIKE 'a%'` is refused as
--     surely as selecting it, which closes the boolean and ordering side
--     channels. `SELECT *` on a table with a withheld column is refused whole,
--     and the tool tells the model to name columns.
--   * may read a few global catalogs (connector_defs, packs, pack_entity_schemas,
--     predicate_defs, rera_cache) that hold no tenant or credential data.
--   * holds no write privilege, no CREATE, no set_config and no EXECUTE on any
--     SECURITY DEFINER function.
--
-- Withheld columns:
--   users.password_hash, users.supertokens_id, users.totp_secret
--   orgs.meta                     the org's inbound webhook secret
--   channels.meta                 WhatsApp and other channel tokens
--   org_invites.token_hash, widget_embed_tokens.token_hash,
--   agent_pending_actions.token_hash, gcal_calendar_watches.channel_token_hash,
--   gcal_calendar_watches.sync_token
-- Withheld tables (whole): org_sql_connections, password_reset_tokens,
--   _migrations, admin_audit_log, impersonation_sessions, platform_admins,
--   platform_send_counters.
--
-- FAIL-CLOSED FOR NEW TABLES AND COLUMNS
-- Nothing is granted by default privilege, so a table added later is invisible to
-- model SQL until a migration says `GRANT SELECT ON <t> TO darex_sql_reader`.
-- A NEW COLUMN on an already-granted table is readable the moment it exists, which
-- is why infra/scripts/check-rls-coverage.js fails on any credential-looking
-- column the reader can read. Both checks tell the author how to fix it.
--
-- TAKING THE DOORS AWAY FROM PUBLIC
-- Functions are executable by PUBLIC unless revoked. This makes the existing
-- grants explicit (darex, darex_app and darex_platform keep exactly what they
-- have), then revokes PUBLIC's EXECUTE on every SECURITY DEFINER function and on
-- set_config. Idempotent.

-- ── Every view must read tenant tables with the CALLER's rights ─────────────
-- A view runs as its owner (a superuser, exempt from RLS) unless declared
-- security_invoker, so an unfiltered SELECT on one returns every tenant's rows.
-- There are no views today; this keeps it that way for any created earlier in a
-- branch, and check-rls-coverage.js catches views created later.
DO $$
DECLARE
  v RECORD;
BEGIN
  FOR v IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'v'
       AND NOT COALESCE('security_invoker=true' = ANY (c.reloptions), FALSE)
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v.relname);
  END LOOP;
END
$$;

-- ── The application role should not create objects in `public` ─────────────
-- infra/db/init granted CREATE ON SCHEMA public on first boot. Nothing at runtime
-- runs DDL (migrations run as the superuser). It only ever served an attacker
-- who can run a stacked statement. A REVOKE is a no-op where it was never granted.
REVOKE CREATE ON SCHEMA public FROM darex_app;

-- ── The role ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'darex_sql_reader') THEN
    CREATE ROLE darex_sql_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Membership is what allows `SET ROLE` from the application role.
GRANT darex_sql_reader TO darex_app;
GRANT USAGE ON SCHEMA public TO darex_sql_reader;

-- ── What it may read ───────────────────────────────────────────────────────
-- Start from nothing so a re-run after the lists change converges.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM darex_sql_reader;

DO $$
DECLARE
  t              RECORD;
  cols           TEXT;
  withheld       TEXT[];
  withheld_whole CONSTANT TEXT[] := ARRAY[
    'org_sql_connections', 'password_reset_tokens', '_migrations', 'admin_audit_log',
    'impersonation_sessions', 'platform_admins', 'platform_send_counters'
  ];
  global_ok      CONSTANT TEXT[] := ARRAY[
    'orgs', 'connector_defs', 'packs', 'pack_entity_schemas', 'predicate_defs', 'rera_cache'
  ];
BEGIN
  FOR t IN
    SELECT c.oid, c.relname,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS has_org
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
  LOOP
    CONTINUE WHEN t.relname = ANY (withheld_whole);
    -- A table with no org_id is not tenant data. Unless it is a known harmless
    -- catalog, the model has no business reading it.
    CONTINUE WHEN NOT t.has_org AND NOT (t.relname = ANY (global_ok));

    withheld := CASE t.relname
      WHEN 'users'                  THEN ARRAY['password_hash', 'supertokens_id', 'totp_secret']
      WHEN 'orgs'                   THEN ARRAY['meta']
      WHEN 'channels'               THEN ARRAY['meta']
      WHEN 'org_invites'            THEN ARRAY['token_hash']
      WHEN 'widget_embed_tokens'    THEN ARRAY['token_hash']
      WHEN 'agent_pending_actions'  THEN ARRAY['token_hash']
      WHEN 'gcal_calendar_watches'  THEN ARRAY['channel_token_hash', 'sync_token']
      ELSE ARRAY[]::TEXT[]
    END;

    IF cardinality(withheld) = 0 THEN
      EXECUTE format('GRANT SELECT ON public.%I TO darex_sql_reader', t.relname);
    ELSE
      SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
        INTO cols
        FROM pg_attribute a
       WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
         AND NOT (a.attname = ANY (withheld));
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO darex_sql_reader', cols, t.relname);
    END IF;
  END LOOP;
END
$$;

-- ── The doors PUBLIC could walk through ────────────────────────────────────
-- Make the existing roles' access explicit FIRST, then remove the implicit one,
-- so nothing the application, the migrations or the platform plane rely on changes.
DO $$
DECLARE
  f RECORD;
  grantees TEXT := 'darex, darex_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'darex_platform') THEN
    grantees := grantees || ', darex_platform';
  END IF;
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', f.sig, grantees);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO %s', grantees);
END
$$;

-- The one function that re-points row-level security. Every role held it by
-- default; only the roles that legitimately set the org context keep it. This is
-- per-database catalog state, so the other databases in the cluster are untouched.
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
