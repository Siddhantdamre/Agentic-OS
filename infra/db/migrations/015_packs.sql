-------------------------------------------------------------------------------
-- Vertical packs + RE India wedge — Migration 015 (WS-21 / P1–P3, C7, K5)
-- Additive. Kernel tables are unchanged. Packs overlay employees, entity
-- schemas, connector *recommendations*, and scheduled workflow names.
--
-- Never marks a Nango connector connected. Asking price / RERA / inventory
-- come from source rows only — NULL if the source did not provide them.
-- Uninstall sets org_packs.status = uninstalled; it does NOT delete
-- conversations, messages, or memory.
--
-- Caller: infra/db/migrate.js. Depends on 012–014.
-- File: infra/db/migrations/015_packs.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. PACKS — global catalog (no org_id; same pattern as connector_defs)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  extends       TEXT,
  markets       TEXT[] NOT NULL DEFAULT '{}',
  live          BOOLEAN NOT NULL DEFAULT false,
  manifest      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE packs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS packs_read_all ON packs;
CREATE POLICY packs_read_all ON packs
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS packs_write_all ON packs;
CREATE POLICY packs_write_all ON packs
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON packs TO darex_app;

-------------------------------------------------------------------------------
-- 2. ORG_PACKS — per-tenant install rows
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_packs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pack_id         TEXT NOT NULL REFERENCES packs(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'pending',
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_primary      BOOLEAN NOT NULL DEFAULT false,
  installed_at    TIMESTAMPTZ,
  uninstalled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_packs_org_pack UNIQUE (org_id, pack_id),
  CONSTRAINT org_packs_status_chk CHECK (
    status IN (
      'pending', 'installing', 'installed', 'failed',
      'uninstalling', 'disabled', 'uninstalled'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_org_packs_org_id ON org_packs (org_id);
CREATE INDEX IF NOT EXISTS idx_org_packs_status ON org_packs (org_id, status);

ALTER TABLE org_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_packs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_packs_org_isolation ON org_packs;
CREATE POLICY org_packs_org_isolation ON org_packs
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_org_packs_updated_at ON org_packs;
CREATE TRIGGER trg_org_packs_updated_at
  BEFORE UPDATE ON org_packs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON org_packs TO darex_app;

-- One primary pack per org (partial unique).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_packs_one_primary
  ON org_packs (org_id)
  WHERE is_primary = true AND status = 'installed';

-------------------------------------------------------------------------------
-- 3. PACK_ENTITY_SCHEMAS — JSON Schema registry per pack entity type
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pack_entity_schemas (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pack_id       TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  json_schema   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pack_entity_schemas_pack_type UNIQUE (pack_id, entity_type)
);

ALTER TABLE pack_entity_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_entity_schemas FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pack_entity_schemas_read_all ON pack_entity_schemas;
CREATE POLICY pack_entity_schemas_read_all ON pack_entity_schemas
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS pack_entity_schemas_write_all ON pack_entity_schemas;
CREATE POLICY pack_entity_schemas_write_all ON pack_entity_schemas
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON pack_entity_schemas TO darex_app;

-------------------------------------------------------------------------------
-- 4. RE_LISTINGS — brokerage inventory projection (Sheets/CSV/licensed feed)
--    list_price is stored as received from source. NULL means unknown.
--    Never fill from a model guess.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS re_listings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source                TEXT NOT NULL DEFAULT 'sheets',
  source_ref            TEXT NOT NULL,
  title                 TEXT,
  locality              TEXT,
  city                  TEXT,
  state                 TEXT,
  country               TEXT NOT NULL DEFAULT 'IN',
  bhk                   INTEGER,
  baths                 NUMERIC,
  area_value            NUMERIC,
  area_unit             TEXT,
  list_price            NUMERIC,
  currency              TEXT NOT NULL DEFAULT 'INR',
  price_on_request      BOOLEAN NOT NULL DEFAULT false,
  rera_id               TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  listed_at             TIMESTAMPTZ,
  last_source_sync_at   TIMESTAMPTZ,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT re_listings_org_source UNIQUE (org_id, source, source_ref),
  CONSTRAINT re_listings_status_chk CHECK (
    status IN (
      'draft', 'active', 'under_offer', 'reserved',
      'sold', 'rented', 'withdrawn', 'stale'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_re_listings_org_id ON re_listings (org_id);
CREATE INDEX IF NOT EXISTS idx_re_listings_filters
  ON re_listings (org_id, status, city, bhk);
CREATE INDEX IF NOT EXISTS idx_re_listings_locality
  ON re_listings (org_id, locality);

ALTER TABLE re_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_listings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS re_listings_org_isolation ON re_listings;
CREATE POLICY re_listings_org_isolation ON re_listings
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_re_listings_updated_at ON re_listings;
CREATE TRIGGER trg_re_listings_updated_at
  BEFORE UPDATE ON re_listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON re_listings TO darex_app;

COMMENT ON TABLE re_listings IS
  'RE listing projection. Sheets/CSV/licensed feed is SoR. list_price and rera_id stay NULL when the source omitted them. Never invent inventory.';
COMMENT ON COLUMN re_listings.list_price IS
  'Asking price as received from source. NULL if unknown — never a model guess.';

-------------------------------------------------------------------------------
-- 5. RE_INQUIRIES — lead against a listing or general requirement
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS re_inquiries (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id        UUID REFERENCES re_listings(id) ON DELETE SET NULL,
  work_item_id      UUID REFERENCES work_items(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id        TEXT,
  channel           TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
  bhk               INTEGER,
  locality          TEXT,
  city              TEXT,
  budget_max        NUMERIC,
  currency          TEXT NOT NULL DEFAULT 'INR',
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT re_inquiries_status_chk CHECK (
    status IN ('new', 'contacted', 'showing', 'closed', 'lost')
  )
);

CREATE INDEX IF NOT EXISTS idx_re_inquiries_org_id ON re_inquiries (org_id);
CREATE INDEX IF NOT EXISTS idx_re_inquiries_status ON re_inquiries (org_id, status);
CREATE INDEX IF NOT EXISTS idx_re_inquiries_listing ON re_inquiries (org_id, listing_id);

ALTER TABLE re_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_inquiries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS re_inquiries_org_isolation ON re_inquiries;
CREATE POLICY re_inquiries_org_isolation ON re_inquiries
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_re_inquiries_updated_at ON re_inquiries;
CREATE TRIGGER trg_re_inquiries_updated_at
  BEFORE UPDATE ON re_inquiries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON re_inquiries TO darex_app;

-------------------------------------------------------------------------------
-- 6. RE_SHOWINGS — tour / site visit
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS re_showings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id        UUID REFERENCES re_listings(id) ON DELETE SET NULL,
  inquiry_id        UUID REFERENCES re_inquiries(id) ON DELETE SET NULL,
  work_item_id      UUID REFERENCES work_items(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'proposed',
  starts_at         TIMESTAMPTZ,
  ends_at           TIMESTAMPTZ,
  calendar_event_id TEXT,
  conflict          BOOLEAN NOT NULL DEFAULT false,
  notes             TEXT,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT re_showings_status_chk CHECK (
    status IN ('proposed', 'booked', 'completed', 'cancelled', 'no_show')
  )
);

CREATE INDEX IF NOT EXISTS idx_re_showings_org_id ON re_showings (org_id);
CREATE INDEX IF NOT EXISTS idx_re_showings_listing ON re_showings (org_id, listing_id);
CREATE INDEX IF NOT EXISTS idx_re_showings_starts ON re_showings (org_id, starts_at);

ALTER TABLE re_showings ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_showings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS re_showings_org_isolation ON re_showings;
CREATE POLICY re_showings_org_isolation ON re_showings
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_re_showings_updated_at ON re_showings;
CREATE TRIGGER trg_re_showings_updated_at
  BEFORE UPDATE ON re_showings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON re_showings TO darex_app;

-------------------------------------------------------------------------------
-- 7. RERA_CACHE — public official fetch (K5). Cite URL + retrieved_at.
--    Global (public data). Stale rows must be labeled, never invented.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rera_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rera_id         TEXT NOT NULL,
  market          TEXT NOT NULL DEFAULT 'IN-MH',
  url             TEXT NOT NULL,
  retrieved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rera_cache_id_market UNIQUE (rera_id, market)
);

CREATE INDEX IF NOT EXISTS idx_rera_cache_expires ON rera_cache (expires_at);

ALTER TABLE rera_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE rera_cache FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rera_cache_read_all ON rera_cache;
CREATE POLICY rera_cache_read_all ON rera_cache
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS rera_cache_write_all ON rera_cache;
CREATE POLICY rera_cache_write_all ON rera_cache
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON rera_cache TO darex_app;

COMMENT ON TABLE rera_cache IS
  'Official RERA lookup cache. Always cite url + retrieved_at. Never invent a registration number.';

-------------------------------------------------------------------------------
-- 8. PM_LEASES / PM_CHARGES — P4 cheap slice: rent reminder + PSP close gate
--    "I paid" without psp_payment_id does NOT close a charge.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pm_leases (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'sheets',
  source_ref    TEXT NOT NULL,
  unit_ref      TEXT,
  tenant_ref    TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pm_leases_org_source UNIQUE (org_id, source, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_pm_leases_org_id ON pm_leases (org_id);

ALTER TABLE pm_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_leases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pm_leases_org_isolation ON pm_leases;
CREATE POLICY pm_leases_org_isolation ON pm_leases
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON pm_leases TO darex_app;

CREATE TABLE IF NOT EXISTS pm_charges (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lease_id          UUID REFERENCES pm_leases(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL DEFAULT 'rent',
  amount            NUMERIC NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  status            TEXT NOT NULL DEFAULT 'open',
  due_at            TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  closed_reason     TEXT,
  psp_payment_id    TEXT,
  claimed_paid_at   TIMESTAMPTZ,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pm_charges_status_chk CHECK (status IN ('open', 'closed', 'void')),
  CONSTRAINT pm_charges_close_gate CHECK (
    status <> 'closed'
    OR psp_payment_id IS NOT NULL
    OR closed_reason IN ('psp_webhook', 'human_confirm')
  )
);

CREATE INDEX IF NOT EXISTS idx_pm_charges_org_id ON pm_charges (org_id);
CREATE INDEX IF NOT EXISTS idx_pm_charges_status ON pm_charges (org_id, status);

ALTER TABLE pm_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE pm_charges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pm_charges_org_isolation ON pm_charges;
CREATE POLICY pm_charges_org_isolation ON pm_charges
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON pm_charges TO darex_app;

COMMENT ON TABLE pm_charges IS
  'PM charges. Amounts from SoR only. Tenant "I paid" sets claimed_paid_at; close requires psp_webhook or human_confirm.';

-------------------------------------------------------------------------------
-- 9. CATALOG SEED — live packs only. RFC ids exist so onboarding can recommend
--    without installing a pack that fails the quality bar.
-------------------------------------------------------------------------------

INSERT INTO packs (id, name, version, extends, markets, live, manifest) VALUES
  (
    'core-b2b',
    'Core B2B',
    '1.0.0',
    NULL,
    ARRAY['IN', 'US', 'AE', 'GB'],
    true,
    '{"id":"core-b2b","onboardingCopy":"Default pack for every org. Connectors stay disconnected until OAuth."}'::jsonb
  ),
  (
    'real-estate-brokerage',
    'Real estate brokerage',
    '1.0.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    true,
    '{"id":"real-estate-brokerage","onboardingCopy":"India wedge: Sheets inventory + WhatsApp + Gmail + Calendar. Never invent price, RERA, or inventory."}'::jsonb
  ),
  (
    'real-estate-pm',
    'Real estate property management',
    '0.1.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    false,
    '{"id":"real-estate-pm","rfc":true}'::jsonb
  ),
  (
    'real-estate-developer',
    'Real estate developer',
    '0.1.0',
    'core-b2b',
    ARRAY['IN'],
    false,
    '{"id":"real-estate-developer","rfc":true}'::jsonb
  ),
  (
    'agencies',
    'Agencies',
    '0.1.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    false,
    '{"id":"agencies","rfc":true}'::jsonb
  ),
  (
    'saas-gtm',
    'SaaS GTM',
    '0.1.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    false,
    '{"id":"saas-gtm","rfc":true}'::jsonb
  ),
  (
    'ecommerce',
    'Ecommerce',
    '0.1.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    false,
    '{"id":"ecommerce","rfc":true}'::jsonb
  ),
  (
    'prof-services',
    'Professional services',
    '0.1.0',
    'core-b2b',
    ARRAY['IN', 'US'],
    false,
    '{"id":"prof-services","rfc":true,"disclosure":"Not licensed legal/tax/financial advice."}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  version = EXCLUDED.version,
  extends = EXCLUDED.extends,
  markets = EXCLUDED.markets,
  live = EXCLUDED.live,
  manifest = EXCLUDED.manifest,
  updated_at = NOW();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
