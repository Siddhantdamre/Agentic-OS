-------------------------------------------------------------------------------
-- Email verification for password signups.
-- users.email_verified_at is NULL until the owner of the address clicks the
-- emailed link. Existing users are backfilled as verified so enabling
-- REQUIRE_EMAIL_VERIFICATION never locks out an account that predates it.
-- Tokens are stored hashed (capability = raw token), single use, 24h expiry.
-- Idempotent. File: infra/db/migrations/209_email_verification.sql
-------------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

UPDATE users SET email_verified_at = COALESCE(created_at, NOW()) WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_verification_tokens TO darex_app;

-- Returns the user id only when the account exists and is still unverified.
CREATE OR REPLACE FUNCTION auth_create_email_verification(
  p_email TEXT,
  p_token_hash TEXT,
  p_expires_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  SELECT u.id INTO v_user_id
  FROM users u
  WHERE lower(u.email) = lower(trim(p_email)) AND u.email_verified_at IS NULL
  LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
  VALUES (v_user_id, p_token_hash, p_expires_at);
  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_consume_email_verification(p_token_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row email_verification_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM email_verification_tokens WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFY_NOT_FOUND';
  END IF;
  IF v_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY_ALREADY_USED';
  END IF;
  IF v_row.expires_at < NOW() THEN
    RAISE EXCEPTION 'VERIFY_EXPIRED';
  END IF;
  UPDATE email_verification_tokens SET used_at = NOW() WHERE id = v_row.id;
  UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = v_row.user_id;
  RETURN v_row.user_id;
END;
$$;

-- Used at signup when the address is already proven (invite sent to it).
CREATE OR REPLACE FUNCTION auth_mark_email_verified(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION auth_is_email_verified(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT email_verified_at IS NOT NULL FROM users WHERE id = p_user_id), FALSE);
$$;

REVOKE ALL ON FUNCTION auth_create_email_verification(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_consume_email_verification(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_mark_email_verified(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_is_email_verified(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_create_email_verification(TEXT, TEXT, TIMESTAMPTZ) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_consume_email_verification(TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_mark_email_verified(UUID) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_is_email_verified(UUID) TO darex_app;
