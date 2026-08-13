-- Seed/repair Nango provider configs for all DareX connectors.
--
-- Reuses the real Google OAuth client_id + client_secret already stored on the
-- 'gmail' config (never hard-coded here). Fixes gmail scopes (adds
-- gmail.compose/gmail.modify needed for draft creation), fills empty scopes
-- (intercom, notion), and ensures all Google Workspace & Google Cloud configs exist.
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
   WHERE unique_key IN ('gmail', 'google', 'google-calendar') AND oauth_client_id IS NOT NULL AND oauth_client_secret IS NOT NULL
   LIMIT 1;

  IF g_client_id IS NULL OR g_client_secret IS NULL THEN
    RAISE NOTICE 'No existing Google config found — skipping automated Google OAuth seed. Configure via Nango UI/API.';
  ELSE
    -- Update existing Google configs with extended scopes matching nango.yaml
    UPDATE nango._nango_configs SET
      oauth_scopes = 'openid email profile https://mail.google.com/ https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels',
      updated_at = NOW()
    WHERE unique_key = 'gmail' AND deleted = false;

    INSERT INTO nango._nango_configs
      (created_at, updated_at, unique_key, provider, oauth_client_id, oauth_client_secret, oauth_scopes, environment_id, deleted)
    VALUES
      (NOW(), NOW(), 'google', 'google', g_client_id, g_client_secret,
       'openid email profile https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets',
       env_id, false),
      (NOW(), NOW(), 'google-calendar', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events',
       env_id, false),
      (NOW(), NOW(), 'google-drive', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.metadata https://www.googleapis.com/auth/drive.activity',
       env_id, false),
      (NOW(), NOW(), 'google-docs', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive',
       env_id, false),
      (NOW(), NOW(), 'google-sheets', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
       env_id, false),
      (NOW(), NOW(), 'google-slides', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive',
       env_id, false),
      (NOW(), NOW(), 'google-forms', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/forms.responses.readonly',
       env_id, false),
      (NOW(), NOW(), 'google-chat', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces',
       env_id, false),
      (NOW(), NOW(), 'google-meet', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/meetings.space.created https://www.googleapis.com/auth/meetings.space.readonly',
       env_id, false),
      (NOW(), NOW(), 'google-contacts', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/directory.readonly',
       env_id, false),
      (NOW(), NOW(), 'google-tasks', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/tasks',
       env_id, false),
      (NOW(), NOW(), 'google-ads', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/adwords',
       env_id, false),
      (NOW(), NOW(), 'google-analytics', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/analytics https://www.googleapis.com/auth/analytics.readonly',
       env_id, false),
      (NOW(), NOW(), 'google-search-console', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/webmasters',
       env_id, false),
      (NOW(), NOW(), 'google-business-profile', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/business.manage',
       env_id, false),
      (NOW(), NOW(), 'google-cloud', 'google', g_client_id, g_client_secret,
       'openid email profile https://www.googleapis.com/auth/cloud-platform',
       env_id, false)
    ON CONFLICT (unique_key, environment_id, deleted_at) DO UPDATE SET
      provider = EXCLUDED.provider,
      oauth_client_id = EXCLUDED.oauth_client_id,
      oauth_client_secret = EXCLUDED.oauth_client_secret,
      oauth_scopes = EXCLUDED.oauth_scopes,
      updated_at = NOW();
  END IF;

  -- Fill empty scopes for providers that require default scopes.
  UPDATE nango._nango_configs SET oauth_scopes = 'read write', updated_at = NOW()
  WHERE unique_key IN ('intercom', 'notion', 'zendesk') AND (oauth_scopes IS NULL OR oauth_scopes = '') AND deleted = false;
END $$;
