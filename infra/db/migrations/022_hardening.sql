-- 022: non-integration hardening — RLS gaps + hot-path indexes.
-- Safe to re-run (IF NOT EXISTS / DO blocks).

-- password_reset_tokens: capability table, must never be tenant-readable.
ALTER TABLE IF EXISTS password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS password_reset_tokens FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'password_reset_tokens_deny_all') THEN
    CREATE POLICY password_reset_tokens_deny_all ON password_reset_tokens FOR ALL USING (false) WITH CHECK (false);
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  REVOKE ALL ON password_reset_tokens FROM PUBLIC, darex_app;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $$;

-- billing_webhook_events: org unknown at webhook time; only SECURITY DEFINER
-- functions may read/write. Tenants get no direct access.
ALTER TABLE IF EXISTS billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS billing_webhook_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'billing_webhook_events_deny_all') THEN
    CREATE POLICY billing_webhook_events_deny_all ON billing_webhook_events FOR ALL USING (false) WITH CHECK (false);
  END IF;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  REVOKE ALL ON billing_webhook_events FROM PUBLIC, darex_app;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $$;

-- Global catalogs: readable by tenants, writable only by owner role (darex).
-- The old FOR ALL USING(true) policies let any tenant DELETE packs/defs.
DO $$ BEGIN
  DROP POLICY IF EXISTS connector_defs_write_all ON connector_defs;
  DROP POLICY IF EXISTS packs_write_all ON packs;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  GRANT SELECT ON connector_defs TO darex_app;
  REVOKE INSERT, UPDATE, DELETE ON connector_defs FROM darex_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  GRANT SELECT ON packs TO darex_app;
  REVOKE INSERT, UPDATE, DELETE ON packs FROM PUBLIC, darex_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- _migrations: owner-only, never tenant-visible.
DO $$ BEGIN
  REVOKE ALL ON _migrations FROM PUBLIC, darex_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  REVOKE ALL ON SEQUENCE _migrations_id_seq FROM PUBLIC, darex_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Hot-path composite indexes (org-scoped queries missed them).
CREATE INDEX IF NOT EXISTS idx_agent_plans_org_status ON agent_plans (org_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_org_status ON conversations (org_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_conv_org ON messages (conversation_id, org_id);
CREATE INDEX IF NOT EXISTS idx_work_events_org_item ON audit_events (org_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_org_plan ON audit_events (org_id, plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_tokens_hash_active
  ON widget_embed_tokens (token_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_channels_chatwoot_inbox ON channels (chatwoot_inbox_id) WHERE chatwoot_inbox_id IS NOT NULL;
