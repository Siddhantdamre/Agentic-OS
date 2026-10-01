-------------------------------------------------------------------------------
-- tool_invocations: append-only audit of every executeAutonomousToolAction
-- call (RT-G06). One row per call, written best-effort after it returns.
-- Raw arguments are never stored: args_hash is SHA-256 of the canonical JSON
-- payload, so a disputed action can be matched without keeping PII here.
-- darex_app may SELECT and INSERT only; no UPDATE / DELETE policy or grant.
-- Rows go away only via the orgs ON DELETE CASCADE (org purge).
-- File: infra/db/migrations/126_tool_invocations_audit.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tool_invocations (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_role  TEXT,
  workflow_id    TEXT,
  tool           TEXT NOT NULL,
  action         TEXT NOT NULL,
  risk           TEXT,
  args_hash      TEXT NOT NULL,
  status         TEXT NOT NULL,
  latency_ms     INTEGER NOT NULL CHECK (latency_ms >= 0),
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_org_created
  ON tool_invocations (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_org_tool
  ON tool_invocations (org_id, tool, created_at DESC);

ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_invocations_tenant_select ON tool_invocations;
CREATE POLICY tool_invocations_tenant_select ON tool_invocations
  FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS tool_invocations_tenant_insert ON tool_invocations;
CREATE POLICY tool_invocations_tenant_insert ON tool_invocations
  FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

REVOKE ALL ON tool_invocations FROM darex_app;
GRANT SELECT, INSERT ON tool_invocations TO darex_app;

COMMENT ON TABLE tool_invocations IS
  'Append-only tool call audit (RT-G06). darex_app: SELECT/INSERT only.';
