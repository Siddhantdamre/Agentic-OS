----------------------------------------------------------------------------
-- Darex Core Schema — Migration 001
-- Every table MUST have org_id + an RLS policy. No exceptions.
-- File: infra/db/migrations/001_core_schema.sql
----------------------------------------------------------------------------
-- 1. ORGANISATIONS TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orgs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',
  status        TEXT NOT NULL DEFAULT 'provisioning',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

----------------------------------------------------------------------------
-- 2. USERS TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  supertokens_id    TEXT UNIQUE,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'agent',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_org_isolation ON users;
CREATE POLICY users_org_isolation ON users
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);

----------------------------------------------------------------------------
-- 3. AI EMPLOYEES TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,
  persona         JSONB NOT NULL DEFAULT '{}',
  tool_allowlist  TEXT[] NOT NULL DEFAULT '{}',
  graph_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'provisioning',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_employees FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_employees_org_isolation ON ai_employees;
CREATE POLICY ai_employees_org_isolation ON ai_employees
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_ai_employees_org_id ON ai_employees(org_id);

----------------------------------------------------------------------------
-- 4. CHANNELS TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  nango_connection_id TEXT,
  chatwoot_inbox_id   INTEGER,
  status          TEXT NOT NULL DEFAULT 'disconnected',
  meta            JSONB NOT NULL DEFAULT '{}',
  connected_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channels_org_isolation ON channels;
CREATE POLICY channels_org_isolation ON channels
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_channels_org_id ON channels(org_id);

----------------------------------------------------------------------------
-- 5. CONVERSATIONS TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id       UUID REFERENCES ai_employees(id),
  channel_id        UUID REFERENCES channels(id),
  chatwoot_conv_id  INTEGER UNIQUE,
  temporal_workflow_id TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  contact_id        TEXT,
  summary           TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_org_isolation ON conversations;
CREATE POLICY conversations_org_isolation ON conversations
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_employee_id ON conversations(employee_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

----------------------------------------------------------------------------
-- 6. MESSAGES TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tool_calls      JSONB,
  chatwoot_msg_id INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_org_isolation ON messages;
CREATE POLICY messages_org_isolation ON messages
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_messages_org_id ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

----------------------------------------------------------------------------
-- 7. ORG ONBOARDING STATE TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_onboarding (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  wizard_step     TEXT NOT NULL DEFAULT 'name',
  business_name   TEXT,
  team_size       INTEGER,
  business_type   TEXT,
  channels_selected TEXT[] DEFAULT '{}',
  provisioning_started_at TIMESTAMPTZ,
  provisioning_completed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE org_onboarding ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_onboarding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_onboarding_org_isolation ON org_onboarding;
CREATE POLICY org_onboarding_org_isolation ON org_onboarding
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

----------------------------------------------------------------------------
-- 8. IDEMPOTENCY KEYS TABLE
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_keys_org_isolation ON idempotency_keys;
CREATE POLICY idempotency_keys_org_isolation ON idempotency_keys
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_org_id ON idempotency_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

----------------------------------------------------------------------------
-- Helper: auto-update `updated_at` on every row mutation
----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Grant app role access to all tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
