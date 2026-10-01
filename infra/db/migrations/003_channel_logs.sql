----------------------------------------------------------------------------
-- Darex Channel Logs Schema — Migration 003
-- Logging every connector API call, Nango session, webhook event & sync attempt
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channel_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  event_type      TEXT NOT NULL, -- 'connect', 'disconnect', 'proxy_call', 'webhook', 'sync'
  status          TEXT NOT NULL, -- 'success', 'error', 'pending'
  status_code     INTEGER DEFAULT 200,
  message         TEXT NOT NULL,
  payload         JSONB DEFAULT '{}',
  response        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE channel_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_logs_org_isolation ON channel_logs;
CREATE POLICY channel_logs_org_isolation ON channel_logs
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_channel_logs_org_id ON channel_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_channel_logs_channel_type ON channel_logs(channel_type);
CREATE INDEX IF NOT EXISTS idx_channel_logs_created_at ON channel_logs(created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON channel_logs TO darex_app;
