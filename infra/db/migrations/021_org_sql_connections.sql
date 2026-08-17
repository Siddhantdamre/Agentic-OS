-------------------------------------------------------------------------------
-- Org SQL warehouse connections — Migration 021 (Workstream C)
-- Tenant-configured warehouse/DB for the agent SQL tool. This is NOT a
-- backdoor into Darex application tables. Agent queries run on a separate
-- connection using parameterized SELECT/WITH only.
-- Passwords are stored as AES-256-GCM ciphertext (ORG_SQL_ENCRYPTION_KEY).
-- File: infra/db/migrations/021_org_sql_connections.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_sql_connections (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL DEFAULT 'default',
  driver                TEXT NOT NULL DEFAULT 'postgres',
  host                  TEXT NOT NULL,
  port                  INTEGER NOT NULL DEFAULT 5432,
  database_name         TEXT NOT NULL,
  username              TEXT NOT NULL,
  password_ciphertext   TEXT,
  ssl_mode              TEXT NOT NULL DEFAULT 'require',
  status                TEXT NOT NULL DEFAULT 'configured',
  last_ok_at            TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_sql_connections_org_uq UNIQUE (org_id),
  CONSTRAINT org_sql_connections_driver_chk CHECK (driver IN ('postgres')),
  CONSTRAINT org_sql_connections_ssl_chk CHECK (ssl_mode IN ('disable', 'require')),
  CONSTRAINT org_sql_connections_status_chk CHECK (
    status IN ('configured', 'verified', 'error', 'disabled')
  ),
  CONSTRAINT org_sql_connections_port_chk CHECK (port >= 1 AND port <= 65535),
  CONSTRAINT org_sql_connections_host_chk CHECK (btrim(host) <> ''),
  CONSTRAINT org_sql_connections_db_chk CHECK (btrim(database_name) <> ''),
  CONSTRAINT org_sql_connections_user_chk CHECK (btrim(username) <> '')
);

CREATE INDEX IF NOT EXISTS idx_org_sql_connections_org_id ON org_sql_connections (org_id);

ALTER TABLE org_sql_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_sql_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_sql_connections_org_isolation ON org_sql_connections;
CREATE POLICY org_sql_connections_org_isolation ON org_sql_connections
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_org_sql_connections_updated_at ON org_sql_connections;
CREATE TRIGGER trg_org_sql_connections_updated_at
  BEFORE UPDATE ON org_sql_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON org_sql_connections TO darex_app;

COMMENT ON TABLE org_sql_connections IS
  'Per-org warehouse/DB for the SQL tool. Never the Darex app database. Password is ciphertext only.';
COMMENT ON COLUMN org_sql_connections.password_ciphertext IS
  'AES-256-GCM packed secret. Decrypt with ORG_SQL_ENCRYPTION_KEY in the worker/API. Never return to the client.';
COMMENT ON COLUMN org_sql_connections.database_name IS
  'Warehouse database name. Must not equal the Darex app DB when host/port match the app cluster.';
