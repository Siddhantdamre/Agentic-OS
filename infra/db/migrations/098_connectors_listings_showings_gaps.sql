-- 093_connectors_listings_showings_gaps.sql
-- Multi-account org_connectors health, listing media/amenities, showings lifecycle fields.
-- Idempotent / IF NOT EXISTS only.

-- ── org_connectors: multi-account + health ─────────────────────────────────
ALTER TABLE org_connectors
  ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS account_label TEXT,
  ADD COLUMN IF NOT EXISTS email_address TEXT,
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ping_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_connectors_health_status_chk'
  ) THEN
    ALTER TABLE org_connectors
      ADD CONSTRAINT org_connectors_health_status_chk
      CHECK (health_status IN ('healthy', 'degraded', 'revoked', 'rate_limited', 'unknown'));
  END IF;
END $$;

ALTER TABLE org_connectors DROP CONSTRAINT IF EXISTS org_connectors_org_key;
ALTER TABLE org_connectors
  ADD CONSTRAINT org_connectors_org_key_account UNIQUE (org_id, connector_key, account_id);

CREATE INDEX IF NOT EXISTS idx_org_connectors_health
  ON org_connectors (org_id, health_status);

-- ── re_listings: amenities + address/geo ───────────────────────────────────
ALTER TABLE re_listings
  ADD COLUMN IF NOT EXISTS amenities TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS address_line TEXT,
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(16),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS re_listing_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES re_listings(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'floor_plan', 'video', 'document')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS re_listing_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES re_listings(id) ON DELETE CASCADE,
  old_price NUMERIC(14, 2) NOT NULL,
  new_price NUMERIC(14, 2) NOT NULL,
  currency TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_listing_media ON re_listing_media (listing_id, display_order ASC);
CREATE INDEX IF NOT EXISTS idx_re_listing_price ON re_listing_price_history (listing_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_re_listing_amenities ON re_listings USING GIN (amenities);

ALTER TABLE re_listing_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_listing_media FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS re_listing_media_org_isolation ON re_listing_media;
CREATE POLICY re_listing_media_org_isolation ON re_listing_media
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE re_listing_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_listing_price_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS re_listing_price_history_org_isolation ON re_listing_price_history;
CREATE POLICY re_listing_price_history_org_isolation ON re_listing_price_history
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON re_listing_media TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON re_listing_price_history TO darex_app;

-- ── re_showings: timezone, duration, feedback, conflict details ────────────
ALTER TABLE re_showings
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS conflict_details JSONB,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS feedback_rating INTEGER,
  ADD COLUMN IF NOT EXISTS feedback_notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 're_showings_duration_chk'
  ) THEN
    ALTER TABLE re_showings
      ADD CONSTRAINT re_showings_duration_chk CHECK (duration_minutes IS NULL OR duration_minutes > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 're_showings_feedback_rating_chk'
  ) THEN
    ALTER TABLE re_showings
      ADD CONSTRAINT re_showings_feedback_rating_chk
      CHECK (feedback_rating IS NULL OR (feedback_rating BETWEEN 1 AND 5));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_re_showings_conflict_check
  ON re_showings (org_id, listing_id, starts_at, ends_at)
  WHERE status IN ('booked', 'proposed');
