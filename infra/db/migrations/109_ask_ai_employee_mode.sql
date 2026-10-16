-------------------------------------------------------------------------------
-- Ask AI employee mode — per-conversation lock + per-user last choice
-- ask_mode / ask_employee_ids restore the Auto / Pick one / Team selector on
-- reload. ask_ai_user_mode_prefs seeds a brand-new chat from the user's last
-- pick (org-scoped). org_preferences is growth rules only — not a fit.
-- File: infra/db/migrations/109_ask_ai_employee_mode.sql
-------------------------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ask_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ask_employee_ids UUID[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_ask_mode_chk'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ask_mode_chk
      CHECK (ask_mode IN ('auto', 'single', 'team'));
  END IF;
END $$;

COMMENT ON COLUMN conversations.ask_mode IS
  'Ask AI mode selector: auto | single | team. Restored on conversation reload.';
COMMENT ON COLUMN conversations.ask_employee_ids IS
  'Employee UUIDs locked for single (len 1) or team (1..3). Empty when auto.';

CREATE TABLE IF NOT EXISTS ask_ai_user_mode_prefs (
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ask_mode          TEXT NOT NULL DEFAULT 'auto'
                      CHECK (ask_mode IN ('auto', 'single', 'team')),
  ask_employee_ids  UUID[] NOT NULL DEFAULT '{}',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE ask_ai_user_mode_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ask_ai_user_mode_prefs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ask_ai_user_mode_prefs_org_isolation ON ask_ai_user_mode_prefs;
CREATE POLICY ask_ai_user_mode_prefs_org_isolation ON ask_ai_user_mode_prefs
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ask_ai_user_mode_prefs TO darex_app;

COMMENT ON TABLE ask_ai_user_mode_prefs IS
  'Per-user Ask AI mode last choice (org-scoped). Seeds brand-new chats when body omits mode.';
