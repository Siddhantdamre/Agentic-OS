-------------------------------------------------------------------------------
-- Shared-pool safety for darex_app, and signup terms consent.
-- Migrations still run as superuser darex and are not under these timeouts.
-- File: infra/db/migrations/115_app_role_timeouts_and_signup_terms.sql
-------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'darex_app') THEN
    EXECUTE 'ALTER ROLE darex_app SET statement_timeout = ''15s''';
    EXECUTE 'ALTER ROLE darex_app SET lock_timeout = ''2s''';
    EXECUTE 'ALTER ROLE darex_app SET idle_in_transaction_session_timeout = ''15s''';
  END IF;
END
$$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

COMMENT ON COLUMN users.terms_accepted_at IS
  'When the user accepted the Terms of Service at email signup. Null for accounts created before this column or via OAuth.';

-- Signup runs before app.current_org_id is set, so the timestamp write is
-- SECURITY DEFINER. The route only calls this after agreedTerms === true.
CREATE OR REPLACE FUNCTION auth_set_terms_accepted(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users
  SET terms_accepted_at = COALESCE(terms_accepted_at, NOW()),
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION auth_set_terms_accepted(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_set_terms_accepted(UUID) TO darex_app;
