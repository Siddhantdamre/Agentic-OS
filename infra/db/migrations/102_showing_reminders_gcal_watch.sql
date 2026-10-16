-- 102_showing_reminders_gcal_watch.sql
-- Showing reminder flags + Google Calendar push watch registry.
-- Idempotent / IF NOT EXISTS only.

ALTER TABLE re_showings
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_re_showings_reminders
  ON re_showings (org_id, starts_at)
  WHERE status = 'booked';

CREATE TABLE IF NOT EXISTS gcal_calendar_watches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_token_hash TEXT NOT NULL,
  resource_id TEXT,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  webhook_address TEXT,
  expiration TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  sync_token TEXT,
  last_notification_at TIMESTAMPTZ,
  not_configured_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gcal_calendar_watches_status_chk CHECK (
    status IN ('pending', 'active', 'not_configured', 'expired', 'revoked')
  ),
  CONSTRAINT gcal_calendar_watches_channel_uniq UNIQUE (channel_id)
);

CREATE INDEX IF NOT EXISTS idx_gcal_calendar_watches_org
  ON gcal_calendar_watches (org_id, status);

ALTER TABLE gcal_calendar_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE gcal_calendar_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gcal_calendar_watches_org_isolation ON gcal_calendar_watches;
CREATE POLICY gcal_calendar_watches_org_isolation ON gcal_calendar_watches
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON gcal_calendar_watches TO darex_app;

-- Webhook lookup without session org GUC (channel id is the only trust key after token verify).
CREATE OR REPLACE FUNCTION resolve_gcal_watch(p_channel_id TEXT)
RETURNS TABLE (
  org_id UUID,
  channel_token_hash TEXT,
  status TEXT,
  sync_token TEXT,
  resource_id TEXT,
  calendar_id TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.org_id, w.channel_token_hash, w.status, w.sync_token, w.resource_id, w.calendar_id
    FROM gcal_calendar_watches w
   WHERE w.channel_id = p_channel_id
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION resolve_gcal_watch(TEXT) TO darex_app;
