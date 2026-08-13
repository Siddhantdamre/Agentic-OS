-------------------------------------------------------------------------------
-- Auth / tenancy hardening — Migration 009
-- Makes login, invite, and getScopedClient work as `darex_app` (FORCE RLS):
--   * unique emails
--   * session-user lookup without org context (SECURITY DEFINER)
--   * org invites + password-reset tokens
--   * channel_logs WITH CHECK (missed in 008)
-- File: infra/db/migrations/009_auth_tenancy.sql
-------------------------------------------------------------------------------

-- Deduplicate emails (keep oldest) so the unique index can be created.
DELETE FROM users u
WHERE u.id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY created_at ASC, id ASC) AS rn
    FROM users
  ) d
  WHERE d.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

-- channel_logs was created in 003 with USING only.
DROP POLICY IF EXISTS channel_logs_org_isolation ON channel_logs;
CREATE POLICY channel_logs_org_isolation ON channel_logs
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- Allow a pooled client to read its own user row before org scope is known.
DROP POLICY IF EXISTS users_self_select ON users;
CREATE POLICY users_self_select ON users
  FOR SELECT
  USING (id::text = current_setting('app.current_user_id', true));

-------------------------------------------------------------------------------
-- SECURITY DEFINER helpers — bypass RLS for auth bootstrap only
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_lookup_user_by_email(p_email TEXT)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  email TEXT,
  role TEXT,
  password_hash TEXT,
  supertokens_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.org_id, u.email, u.role, u.password_hash, u.supertokens_id
  FROM users u
  WHERE lower(u.email) = lower(trim(p_email))
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION auth_lookup_user_by_id(p_id UUID)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  email TEXT,
  role TEXT,
  password_hash TEXT,
  supertokens_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.org_id, u.email, u.role, u.password_hash, u.supertokens_id
  FROM users u
  WHERE u.id = p_id
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION auth_insert_user(
  p_org_id UUID,
  p_email TEXT,
  p_role TEXT,
  p_supertokens_id TEXT,
  p_password_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO users (org_id, email, role, supertokens_id, password_hash)
  VALUES (p_org_id, lower(trim(p_email)), p_role, p_supertokens_id, p_password_hash)
  ON CONFLICT (supertokens_id) DO UPDATE
    SET email = EXCLUDED.email,
        org_id = COALESCE(users.org_id, EXCLUDED.org_id),
        password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
  RETURNING users.id INTO v_id;

  INSERT INTO org_onboarding (org_id, wizard_step)
  VALUES (p_org_id, 'name')
  ON CONFLICT (org_id) DO NOTHING;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_attach_user_to_org(
  p_user_id UUID,
  p_org_id UUID,
  p_role TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users
  SET org_id = p_org_id,
      role = COALESCE(p_role, role),
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_update_password_hash(
  p_user_id UUID,
  p_password_hash TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users
  SET password_hash = p_password_hash,
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_link_supertokens_id(
  p_user_id UUID,
  p_supertokens_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE users
  SET supertokens_id = p_supertokens_id,
      updated_at = NOW()
  WHERE id = p_user_id
    AND (supertokens_id IS NULL OR supertokens_id IS DISTINCT FROM p_supertokens_id);
END;
$$;

-------------------------------------------------------------------------------
-- Invites
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_invites (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invites FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_invites_org_isolation ON org_invites;
CREATE POLICY org_invites_org_isolation ON org_invites
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_org_invites_org_id ON org_invites(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_pending_email
  ON org_invites (org_id, lower(email))
  WHERE accepted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON org_invites TO darex_app;

CREATE OR REPLACE FUNCTION auth_lookup_invite_by_token_hash(p_token_hash TEXT)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  email TEXT,
  role TEXT,
  org_name TEXT,
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.org_id, i.email, i.role, o.name, i.expires_at, i.accepted_at
  FROM org_invites i
  JOIN orgs o ON o.id = i.org_id
  WHERE i.token_hash = p_token_hash
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION auth_accept_invite(
  p_token_hash TEXT,
  p_user_id UUID
) RETURNS TABLE (org_id UUID, role TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite org_invites%ROWTYPE;
  v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_invite FROM org_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND';
  END IF;
  IF v_invite.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_ALREADY_ACCEPTED';
  END IF;
  IF v_invite.expires_at < NOW() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED';
  END IF;

  SELECT * INTO v_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;
  IF lower(v_user.email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH';
  END IF;
  IF v_user.org_id IS NOT NULL AND v_user.org_id <> v_invite.org_id THEN
    -- Allow moving only when the current org has no other members (placeholder
    -- org created at signup before the invite was accepted).
    IF EXISTS (
      SELECT 1 FROM users u
      WHERE u.org_id = v_user.org_id AND u.id <> v_user.id
    ) THEN
      RAISE EXCEPTION 'USER_ALREADY_IN_ORG';
    END IF;
  END IF;

  UPDATE users
  SET org_id = v_invite.org_id,
      role = v_invite.role,
      updated_at = NOW()
  WHERE id = p_user_id;

  UPDATE org_invites
  SET accepted_at = NOW()
  WHERE id = v_invite.id;

  -- Mark onboarding complete for invitees joining an existing org.
  INSERT INTO org_onboarding (org_id, wizard_step, provisioning_completed_at)
  VALUES (v_invite.org_id, 'channels', NOW())
  ON CONFLICT (org_id) DO UPDATE
    SET provisioning_completed_at = COALESCE(org_onboarding.provisioning_completed_at, NOW());

  org_id := v_invite.org_id;
  role := v_invite.role;
  RETURN NEXT;
END;
$$;

-------------------------------------------------------------------------------
-- Password reset tokens (capability = hashed token; no FORCE RLS)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO darex_app;

CREATE OR REPLACE FUNCTION auth_create_password_reset(
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
  SELECT u.id INTO v_user_id FROM users u WHERE lower(u.email) = lower(trim(p_email)) LIMIT 1;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (v_user_id, p_token_hash, p_expires_at);
  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION auth_consume_password_reset(p_token_hash TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row password_reset_tokens%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM password_reset_tokens
  WHERE token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESET_NOT_FOUND';
  END IF;
  IF v_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESET_ALREADY_USED';
  END IF;
  IF v_row.expires_at < NOW() THEN
    RAISE EXCEPTION 'RESET_EXPIRED';
  END IF;
  UPDATE password_reset_tokens SET used_at = NOW() WHERE id = v_row.id;
  RETURN v_row.user_id;
END;
$$;

REVOKE ALL ON FUNCTION auth_lookup_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_user_by_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_insert_user(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_attach_user_to_org(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_update_password_hash(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_link_supertokens_id(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_invite_by_token_hash(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_accept_invite(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_create_password_reset(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_consume_password_reset(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_user_by_email(TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_lookup_user_by_id(UUID) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_insert_user(UUID, TEXT, TEXT, TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_attach_user_to_org(UUID, UUID, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_update_password_hash(UUID, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_link_supertokens_id(UUID, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_lookup_invite_by_token_hash(TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_accept_invite(TEXT, UUID) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_create_password_reset(TEXT, TEXT, TIMESTAMPTZ) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_consume_password_reset(TEXT) TO darex_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
