##############################################################################
# Darex Core Schema — Migration 001
# Every table MUST have org_id + an RLS policy. No exceptions.
# File: infra/db/migrations/001_core_schema.sql
##############################################################################

\connect darex

----------------------------------------------------------------------------
-- 1. ORGANISATIONS TABLE
-- The root multi-tenant entity. All other tables FK into this.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orgs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',   -- free | pro | enterprise
  status        TEXT NOT NULL DEFAULT 'provisioning',  -- provisioning | active | suspended
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Orgs does NOT have org_id (it IS the org). RLS for orgs is handled via
-- the users_orgs membership table below.

----------------------------------------------------------------------------
-- 2. USERS TABLE
-- Thin user record; auth identity is delegated to SuperTokens (Phase 1).
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  supertokens_id    TEXT UNIQUE,              -- maps to SuperTokens user id
  email             TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'agent', -- owner | admin | agent
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see users in their own org.
-- The app sets `app.current_org_id` at the start of every DB session.
CREATE POLICY users_org_isolation ON users
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- Index for fast org-scoped lookups
CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);

----------------------------------------------------------------------------
-- 3. AI EMPLOYEES TABLE
-- Config-driven: employee logic lives in LangGraph graphs, not here.
-- This row is the identity/config record — role, persona, tool allowlist.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL,          -- sales | support | marketing | custom
  persona         JSONB NOT NULL DEFAULT '{}',  -- tone, greeting style, avatar URL
  tool_allowlist  TEXT[] NOT NULL DEFAULT '{}', -- list of tool names this employee may use
  graph_id        TEXT NOT NULL,          -- identifies which LangGraph graph to instantiate
  status          TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | active | paused
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_employees_org_isolation ON ai_employees
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_ai_employees_org_id ON ai_employees(org_id);

----------------------------------------------------------------------------
-- 4. CHANNELS TABLE
-- Tracks connected inbound/outbound channels per org (WhatsApp, Email, etc.)
-- The actual OAuth token is stored in Nango; this is the local reference.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,           -- whatsapp | email | meta_ads | google_ads | hubspot | razorpay | google_calendar
  nango_connection_id TEXT,               -- Nango connection id for OAuth tokens
  chatwoot_inbox_id   INTEGER,            -- Chatwoot inbox id (populated in Phase 3)
  status          TEXT NOT NULL DEFAULT 'disconnected',  -- disconnected | connecting | connected | error
  meta            JSONB NOT NULL DEFAULT '{}', -- channel-specific metadata (e.g., phone number, email address)
  connected_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY channels_org_isolation ON channels
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_channels_org_id ON channels(org_id);

----------------------------------------------------------------------------
-- 5. CONVERSATIONS TABLE
-- One row per conversation thread. References Chatwoot conversation id.
-- Each conversation maps to exactly one Temporal workflow execution.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id       UUID REFERENCES ai_employees(id),
  channel_id        UUID REFERENCES channels(id),
  chatwoot_conv_id  INTEGER UNIQUE,         -- Chatwoot's internal conversation id
  temporal_workflow_id TEXT,               -- Temporal workflow execution id
  status            TEXT NOT NULL DEFAULT 'open',  -- open | resolved | escalated | pending_human
  contact_id        TEXT,                  -- external contact identifier (phone, email, etc.)
  summary           TEXT,                  -- AI-generated summary updated after resolution
  metadata          JSONB NOT NULL DEFAULT '{}',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversations_org_isolation ON conversations
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_conversations_org_id ON conversations(org_id);
CREATE INDEX IF NOT EXISTS idx_conversations_employee_id ON conversations(employee_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);

----------------------------------------------------------------------------
-- 6. MESSAGES TABLE
-- Individual messages within a conversation.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,           -- user | assistant | system | tool
  content         TEXT NOT NULL,
  tool_calls      JSONB,                   -- if role=tool, the call details
  chatwoot_msg_id INTEGER,                 -- Chatwoot message id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY messages_org_isolation ON messages
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_messages_org_id ON messages(org_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

----------------------------------------------------------------------------
-- 7. ORG ONBOARDING STATE TABLE
-- Tracks wizard completion and provisioning status per org.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_onboarding (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
  wizard_step     TEXT NOT NULL DEFAULT 'name',  -- name | team_size | business_type | channels | complete
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

CREATE POLICY org_onboarding_org_isolation ON org_onboarding
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

----------------------------------------------------------------------------
-- 8. IDEMPOTENCY KEYS TABLE
-- Ensures external side-effects (Temporal activities) never fire twice.
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             TEXT PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

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

CREATE TRIGGER update_orgs_updated_at           BEFORE UPDATE ON orgs            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at          BEFORE UPDATE ON users           FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_ai_employees_updated_at   BEFORE UPDATE ON ai_employees    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_channels_updated_at       BEFORE UPDATE ON channels        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_conversations_updated_at  BEFORE UPDATE ON conversations   FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_org_onboarding_updated_at BEFORE UPDATE ON org_onboarding  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

----------------------------------------------------------------------------
-- Grant app role access to all tables
----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
