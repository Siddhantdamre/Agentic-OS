-------------------------------------------------------------------------------
-- Connector registry — Migration 014 (WS-07 / C3)
-- Global catalog (`connector_defs`) plus per-org connection + sync-cursor
-- tables. Packs recommend by inserting/reading defs; they must NOT mark
-- an org connected. Connected is Nango-verified in GET /api/integrations.
-- File: infra/db/migrations/014_connector_registry.sql
-- Seed: infra/db/seeds/connector_defs.sql
-------------------------------------------------------------------------------

----------------------------------------------------------------------------
-- 1. CONNECTOR_DEFS — global catalog (no org_id)
--    Readable by every tenant. Writes are seed/admin, not request-body org.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_defs (
  key                   TEXT PRIMARY KEY,
  nango_key             TEXT,
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT '',
  icon                  TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  auth_mode             TEXT NOT NULL DEFAULT 'oauth',
  risk_class            TEXT NOT NULL DEFAULT 'read',
  confirm_policy        TEXT NOT NULL DEFAULT 'none',
  vertical_tags         TEXT[] NOT NULL DEFAULT '{}',
  mcp_tools             TEXT[] NOT NULL DEFAULT '{}',
  extra_connect_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra_test_fields     JSONB NOT NULL DEFAULT '[]'::jsonb,
  executor_status       TEXT NOT NULL DEFAULT 'live',
  testable              BOOLEAN NOT NULL DEFAULT true,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  env_vars              JSONB NOT NULL DEFAULT '[]'::jsonb,
  webhook_events        TEXT[] NOT NULL DEFAULT '{}',
  operator_hint         TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT connector_defs_auth_mode_chk CHECK (
    auth_mode IN ('oauth', 'api_key', 'byok', 'service_account')
  ),
  CONSTRAINT connector_defs_risk_class_chk CHECK (
    risk_class IN ('read', 'draft', 'send', 'write_sor', 'pay', 'delete', 'publish', 'sign')
  ),
  CONSTRAINT connector_defs_confirm_policy_chk CHECK (
    confirm_policy IN ('none', 'confirm')
  ),
  CONSTRAINT connector_defs_executor_status_chk CHECK (
    executor_status IN ('live', 'catalog_only')
  )
);

CREATE INDEX IF NOT EXISTS idx_connector_defs_nango_key ON connector_defs (nango_key);
CREATE INDEX IF NOT EXISTS idx_connector_defs_risk_class ON connector_defs (risk_class);
CREATE INDEX IF NOT EXISTS idx_connector_defs_sort_order ON connector_defs (sort_order);

ALTER TABLE connector_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_defs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connector_defs_read_all ON connector_defs;
CREATE POLICY connector_defs_read_all ON connector_defs
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS connector_defs_write_all ON connector_defs;
CREATE POLICY connector_defs_write_all ON connector_defs
  FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON connector_defs TO darex_app;

----------------------------------------------------------------------------
-- 2. ORG_CONNECTORS — per-tenant connection rows
--    status is a cache only. GET /api/integrations re-verifies Nango
--    before setting connected:true. A def without a row is "recommended,
--    not connected".
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_connectors (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_key         TEXT NOT NULL REFERENCES connector_defs(key) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'disconnected',
  nango_connection_id   TEXT,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  last_ok_at            TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_connectors_org_key UNIQUE (org_id, connector_key),
  CONSTRAINT org_connectors_status_chk CHECK (
    status IN ('pending', 'connected', 'disconnected', 'error', 'disabled')
  )
);

CREATE INDEX IF NOT EXISTS idx_org_connectors_org_id ON org_connectors (org_id);
CREATE INDEX IF NOT EXISTS idx_org_connectors_key ON org_connectors (connector_key);

ALTER TABLE org_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_connectors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_connectors_org_isolation ON org_connectors;
CREATE POLICY org_connectors_org_isolation ON org_connectors
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON org_connectors TO darex_app;

----------------------------------------------------------------------------
-- 3. SYNC_CURSORS — per-org incremental sync position (knowledge ingest)
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_cursors (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_key   TEXT NOT NULL REFERENCES connector_defs(key) ON DELETE CASCADE,
  stream          TEXT NOT NULL,
  cursor          TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sync_cursors_org_key_stream UNIQUE (org_id, connector_key, stream)
);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_org_id ON sync_cursors (org_id);
CREATE INDEX IF NOT EXISTS idx_sync_cursors_connector ON sync_cursors (org_id, connector_key);

ALTER TABLE sync_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_cursors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_cursors_org_isolation ON sync_cursors;
CREATE POLICY sync_cursors_org_isolation ON sync_cursors
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON sync_cursors TO darex_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
