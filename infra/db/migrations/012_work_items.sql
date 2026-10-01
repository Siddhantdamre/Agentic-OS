-------------------------------------------------------------------------------
-- Work items — WS-06 / O1
-- Additive. Conversations remain the inbox source; each inbound conversation
-- gets one work_item (type=conversation). Packs later register re.inquiry, etc.
-- Caller: infra/db/migrate.js. Depends on 009–011.
-- File: infra/db/migrations/012_work_items.sql
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work_items (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL DEFAULT 'conversation',
  status                TEXT NOT NULL DEFAULT 'open',
  assignee_employee_id  UUID REFERENCES ai_employees(id) ON DELETE SET NULL,
  conversation_id       UUID REFERENCES conversations(id) ON DELETE SET NULL,
  channel               TEXT,
  entity_refs           JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority              TEXT NOT NULL DEFAULT 'normal',
  due_at                TIMESTAMPTZ,
  temporal_workflow_id  TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_items_org_isolation ON work_items;
CREATE POLICY work_items_org_isolation ON work_items
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_work_items_org_id ON work_items(org_id);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(org_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_assignee ON work_items(org_id, assignee_employee_id);

-- One conversation-typed work item per org conversation (inbound wrap).
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_org_conversation
  ON work_items (org_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_work_items_updated_at ON work_items;
CREATE TRIGGER update_work_items_updated_at
  BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-------------------------------------------------------------------------------
-- Work events — append-only ledger on a work item
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS work_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  work_item_id      UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor             TEXT,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE work_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_events_org_isolation ON work_events;
CREATE POLICY work_events_org_isolation ON work_events
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_work_events_org_id ON work_events(org_id);
CREATE INDEX IF NOT EXISTS idx_work_events_work_item_id ON work_events(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_events_kind ON work_events(org_id, kind);

-- Duplicate webhook / activity retries must not insert a second event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_events_org_idempotency
  ON work_events (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON work_items TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_events TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
