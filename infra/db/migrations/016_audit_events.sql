-------------------------------------------------------------------------------
-- Audit events + DSR requests — Migration 016 (WS-22 / S3, S6)
-- Who approved, model, tools, Langfuse id. DSR export/delete includes vectors.
-- Auditor reads this table; cannot call pay (enforced in /api/agent/tools).
-- File: infra/db/migrations/016_audit_events.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  actor_type          TEXT NOT NULL,
  actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_employee_id   UUID REFERENCES ai_employees(id) ON DELETE SET NULL,
  actor_component     TEXT,
  work_item_id        UUID REFERENCES work_items(id) ON DELETE SET NULL,
  plan_id             UUID REFERENCES agent_plans(id) ON DELETE SET NULL,
  confirm_id          UUID,
  approver_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  tool                TEXT,
  action              TEXT,
  risk_class          TEXT,
  model               TEXT,
  prompt_hash         TEXT,
  langfuse_trace_id   TEXT,
  result_status       TEXT NOT NULL DEFAULT 'ok',
  data_classes        TEXT[] NOT NULL DEFAULT '{}',
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_events_kind_chk CHECK (kind IN (
    'tool.execute',
    'plan.approve',
    'plan.reject',
    'plan.execute',
    'connector.connect',
    'connector.disconnect',
    'memory.write',
    'memory.delete',
    'memory.correct',
    'pack.install',
    'pack.uninstall',
    'dsr.export',
    'dsr.delete',
    'role.change',
    'login',
    'confirm.override'
  )),
  CONSTRAINT audit_events_actor_type_chk CHECK (actor_type IN ('user', 'employee', 'system')),
  CONSTRAINT audit_events_result_chk CHECK (result_status IN ('ok', 'error', 'denied'))
);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_events_org_isolation ON audit_events;
CREATE POLICY audit_events_org_isolation ON audit_events
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_id ON audit_events (org_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_kind ON audit_events (org_id, kind);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_approver ON audit_events (org_id, approver_user_id)
  WHERE approver_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_langfuse ON audit_events (org_id, langfuse_trace_id)
  WHERE langfuse_trace_id IS NOT NULL;

COMMENT ON TABLE audit_events IS
  'Org-scoped compliance log. Who approved a send/pay/sign lives in approver_user_id. Langfuse id when present.';
COMMENT ON COLUMN audit_events.approver_user_id IS
  'Human who approved an irreversible action. Null when the event is a pause or system deny.';
COMMENT ON COLUMN audit_events.langfuse_trace_id IS
  'Langfuse trace id when the turn was traced. Never store the full PII prompt.';

-------------------------------------------------------------------------------
-- DSR requests (export / delete). Delete always includes vectors.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dsr_requests (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  requested_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  include_memory        BOOLEAN NOT NULL DEFAULT true,
  include_files         BOOLEAN NOT NULL DEFAULT true,
  include_vectors       BOOLEAN NOT NULL DEFAULT true,
  result                JSONB NOT NULL DEFAULT '{}'::jsonb,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  CONSTRAINT dsr_requests_kind_chk CHECK (kind IN ('export', 'delete')),
  CONSTRAINT dsr_requests_status_chk CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

ALTER TABLE dsr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dsr_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dsr_requests_org_isolation ON dsr_requests;
CREATE POLICY dsr_requests_org_isolation ON dsr_requests
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_dsr_requests_org_id ON dsr_requests (org_id);
CREATE INDEX IF NOT EXISTS idx_dsr_requests_status ON dsr_requests (org_id, status);

COMMENT ON TABLE dsr_requests IS
  'DSR export/delete jobs. Delete always wipes pgvector embeddings for this org only (RLS).';
COMMENT ON COLUMN dsr_requests.include_vectors IS
  'Always true for kind=delete. Neighbor org vectors are not visible under RLS.';

GRANT SELECT, INSERT, UPDATE, DELETE ON audit_events TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dsr_requests TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
