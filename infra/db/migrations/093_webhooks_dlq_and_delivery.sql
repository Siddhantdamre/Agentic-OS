-- Webhook DLQ + message delivery status (gap26sept webhooks hardening)

CREATE TABLE IF NOT EXISTS failed_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  source_ip TEXT,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload TEXT NOT NULL,
  error_message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved', 'replayed', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replayed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_failed_webhooks_channel_status
  ON failed_webhooks (channel, status, created_at DESC);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'sent'
    CHECK (delivery_status IS NULL OR delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
  ON messages (org_id, delivery_status)
  WHERE delivery_status IS NOT NULL AND delivery_status <> 'read';

GRANT SELECT, INSERT, UPDATE ON failed_webhooks TO darex_app;
