-- More than one WhatsApp number per org.
-- A channel is now unique per (org, type, account_key). account_key is '' for
-- every existing row (the "primary" connection), so nothing changes for other
-- channel types; extra WhatsApp numbers get their own short key.
-- Code that upserts channels must use ON CONFLICT (org_id, channel_type, account_key).

ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_org_type_account_unique
  ON channels(org_id, channel_type, account_key);

DROP INDEX IF EXISTS idx_channels_org_type_unique;
