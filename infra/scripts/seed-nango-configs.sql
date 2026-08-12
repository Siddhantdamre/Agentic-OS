-- Seed/repair Nango provider configs for all DareX connectors.
--
-- Reuses the real Google OAuth client_id + client_secret already stored on the
-- 'gmail' config (never hard-coded here). Fixes gmail scopes (adds
-- gmail.compose/gmail.modify needed for draft creation), fills empty scopes
-- (intercom, notion), and ensures google-drive/docs/sheets configs exist.
-- Run from repo root:
--   docker compose -f infra/docker-compose.yml exec -T postgres psql -U darex -d nango < infra/scripts/seed-nango-configs.sql
-- Then restart Nango so it reloads its config cache:
--   docker compose -f infra/docker-compose.yml restart nango-server

DO $$
DECLARE
  env_id int;
  g_client_id varchar(255);
  g_client_secret text;
BEGIN
  SELECT environment_id, oauth_client_id, oauth_client_secret
    INTO env_id, g_client_id, g_client_secret
    FROM nango._nango_configs
   WHERE unique_key = 'gmail'
   LIMIT 1;

  IF g_client_id IS NULL OR g_client_secret IS NULL THEN
    RAISE EXCEPTION 'gmail config not found or missing client credentials — cannot seed google apps';
  END IF;

  -- Fix gmail scopes: draft_email uses gmail.compose, send uses gmail.send.
  UPDATE nango._nango_configs SET
    oauth_scopes = 'openid email profile https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify',
    updated_at = NOW()
  WHERE unique_key = 'gmail' AND deleted = false;

  -- Fill empty scopes for providers that require them to OAuth at all.
  UPDATE nango._nango_configs SET oauth_scopes = 'read write', updated_at = NOW()
  WHERE unique_key IN ('intercom', 'notion') AND (oauth_scopes IS NULL OR oauth_scopes = '') AND deleted = false;

  INSERT INTO nango._nango_configs
    (created_at, updated_at, unique_key, provider, oauth_client_id, oauth_client_secret, oauth_scopes, environment_id, deleted)
  VALUES
    (NOW(), NOW(), 'google-drive', 'google', g_client_id, g_client_secret,
     'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',
     env_id, false),
    (NOW(), NOW(), 'google-docs', 'google', g_client_id, g_client_secret,
     'openid email profile https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file',
     env_id, false),
    (NOW(), NOW(), 'google-sheets', 'google', g_client_id, g_client_secret,
     'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
     env_id, false)
  ON CONFLICT (unique_key, environment_id, deleted_at) DO UPDATE SET
    provider = EXCLUDED.provider,
    oauth_client_id = EXCLUDED.oauth_client_id,
    oauth_client_secret = EXCLUDED.oauth_client_secret,
    oauth_scopes = EXCLUDED.oauth_scopes,
    updated_at = NOW();
END $$;
