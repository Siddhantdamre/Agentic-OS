-------------------------------------------------------------------------------
-- Insight engine + learning loop — Migration 020 (WS-20 / A3, A5, B4)
-- Thumbs and human-named playbook promotion. Org-scoped only.
-- Never stores raw message bodies for training. No cross-org rows.
-- File: infra/db/migrations/020_insight_learning.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. ASK_AI_FEEDBACK — thumbs on Ask AI (B4). Vote only, no transcript copy.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ask_ai_feedback (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  plan_id           UUID REFERENCES agent_plans(id) ON DELETE SET NULL,
  message_id        TEXT,
  vote              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ask_ai_feedback_vote_chk CHECK (vote IN ('up', 'down'))
);

CREATE INDEX IF NOT EXISTS idx_ask_ai_feedback_org_id ON ask_ai_feedback (org_id);
CREATE INDEX IF NOT EXISTS idx_ask_ai_feedback_conversation
  ON ask_ai_feedback (org_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ask_ai_feedback_user_message
  ON ask_ai_feedback (org_id, user_id, message_id)
  WHERE message_id IS NOT NULL AND user_id IS NOT NULL;

ALTER TABLE ask_ai_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_ai_feedback FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ask_ai_feedback_org_isolation ON ask_ai_feedback;
CREATE POLICY ask_ai_feedback_org_isolation ON ask_ai_feedback
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON ask_ai_feedback TO darex_app;

COMMENT ON TABLE ask_ai_feedback IS
  'Ask AI thumbs. Stores vote + ids only — never a message body for training.';

-------------------------------------------------------------------------------
-- 2. ORG_PLAYBOOK_PROMOTIONS — human-named plan → org skill (A5).
--    Steps only (tool/action/description). No draft / transcript PII.
--    Replay uses the playbook matcher, not a new runtime.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_playbook_promotions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  playbook_id         TEXT NOT NULL,
  name                TEXT NOT NULL,
  plan_id             UUID REFERENCES agent_plans(id) ON DELETE SET NULL,
  steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary             TEXT NOT NULL DEFAULT '',
  named_by_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_playbook_promotions_org_id UNIQUE (org_id, playbook_id),
  CONSTRAINT org_playbook_promotions_name_len CHECK (char_length(btrim(name)) BETWEEN 3 AND 80),
  CONSTRAINT org_playbook_promotions_id_prefix CHECK (playbook_id LIKE 'org.%')
);

CREATE INDEX IF NOT EXISTS idx_org_playbook_promotions_org_id
  ON org_playbook_promotions (org_id);

ALTER TABLE org_playbook_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_playbook_promotions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_playbook_promotions_org_isolation ON org_playbook_promotions;
CREATE POLICY org_playbook_promotions_org_isolation ON org_playbook_promotions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_org_playbook_promotions_updated_at ON org_playbook_promotions;
CREATE TRIGGER trg_org_playbook_promotions_updated_at
  BEFORE UPDATE ON org_playbook_promotions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON org_playbook_promotions TO darex_app;

COMMENT ON TABLE org_playbook_promotions IS
  'Human-named org playbooks promoted from winning plans. Never trains on another tenant.';
