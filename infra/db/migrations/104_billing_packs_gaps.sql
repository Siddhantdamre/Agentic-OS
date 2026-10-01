-------------------------------------------------------------------------------
-- Billing audit + dunning + packs attribution — Migration 104
-- Additive. Never trusts client org_id (app still uses getScopedClient).
-- File: infra/db/migrations/104_billing_packs_gaps.sql
-------------------------------------------------------------------------------

-- 1. Billing audit trail (human + webhook-driven subscription mutations)
CREATE TABLE IF NOT EXISTS billing_audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  provider        TEXT,
  plan_key        TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_audit_log_action_chk CHECK (action IN (
    'checkout_started',
    'plan_changed',
    'cancel_requested',
    'cancel_immediate',
    'portal_opened',
    'dunning_entered',
    'dunning_cleared',
    'downgrade_to_free'
  ))
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_log_org_created
  ON billing_audit_log (org_id, created_at DESC);

ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_audit_log_org_isolation ON billing_audit_log;
CREATE POLICY billing_audit_log_org_isolation ON billing_audit_log
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

GRANT SELECT, INSERT ON billing_audit_log TO darex_app;

-- 2. Dunning grace on subscriptions
ALTER TABLE billing_subscriptions
  ADD COLUMN IF NOT EXISTS dunning_grace_ends_at TIMESTAMPTZ;

COMMENT ON COLUMN billing_subscriptions.dunning_grace_ends_at IS
  'When set, org is in dunning grace after payment_failed. Null when current.';

-- 3. Pack attribution + version tracking
ALTER TABLE ai_employees
  ADD COLUMN IF NOT EXISTS pack_id TEXT REFERENCES packs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_employees_pack
  ON ai_employees (org_id, pack_id)
  WHERE pack_id IS NOT NULL;

ALTER TABLE org_packs
  ADD COLUMN IF NOT EXISTS installed_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS last_upgraded_at TIMESTAMPTZ;

-- Expand audit_events kinds for pack config/upgrade (keep pack.install/uninstall)
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_chk;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_chk CHECK (kind IN (
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
  'pack.upgrade',
  'pack.config_update',
  'dsr.export',
  'dsr.delete',
  'role.change',
  'login',
  'confirm.override'
));
