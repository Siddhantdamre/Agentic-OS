-- Ensure a channel can only exist once per org + type.
-- Required for the ON CONFLICT (org_id, channel_type) upserts used across the app.

-- Dedupe any existing duplicate rows (keep the lowest id) before adding the constraint.
DELETE FROM channels a USING channels b
WHERE a.id > b.id
  AND a.org_id = b.org_id
  AND a.channel_type = b.channel_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_org_type_unique
  ON channels(org_id, channel_type);
