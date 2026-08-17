-------------------------------------------------------------------------------
-- RLS hardening — Migration 008
-- The original ORG-isolation policies only had `USING`, which permits SELECT
-- (and UPDATE/DELETE of existing rows) but REJECTS INSERT/UPDATE of new rows
-- whenever RLS is actually enforced (a policy needs a `WITH CHECK` clause for
-- writes). Add the matching `WITH CHECK` to every tenant-scoped table so the
-- least-privilege `darex_app` role can write its own org's rows.
--
-- Also fixes the RLS context bug: the app now sets `app.current_org_id` at the
-- SESSION level (is_local=false) per connection instead of `SET LOCAL` which
-- expired after the single statement, silently disabling RLS.
-- File: infra/db/migrations/008_rls_with_check.sql
-------------------------------------------------------------------------------

-- users
DROP POLICY IF EXISTS users_org_isolation ON users;
CREATE POLICY users_org_isolation ON users
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- ai_employees
DROP POLICY IF EXISTS ai_employees_org_isolation ON ai_employees;
CREATE POLICY ai_employees_org_isolation ON ai_employees
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- channels
DROP POLICY IF EXISTS channels_org_isolation ON channels;
CREATE POLICY channels_org_isolation ON channels
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- conversations
DROP POLICY IF EXISTS conversations_org_isolation ON conversations;
CREATE POLICY conversations_org_isolation ON conversations
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- messages
DROP POLICY IF EXISTS messages_org_isolation ON messages;
CREATE POLICY messages_org_isolation ON messages
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- org_onboarding
DROP POLICY IF EXISTS org_onboarding_org_isolation ON org_onboarding;
CREATE POLICY org_onboarding_org_isolation ON org_onboarding
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- idempotency_keys
DROP POLICY IF EXISTS idempotency_keys_org_isolation ON idempotency_keys;
CREATE POLICY idempotency_keys_org_isolation ON idempotency_keys
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- agent_plans
DROP POLICY IF EXISTS agent_plans_org_isolation ON agent_plans;
CREATE POLICY agent_plans_org_isolation ON agent_plans
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

-- agent_plans was created after the migration-001 blanket grant, so grant the
-- least-privilege app role explicit access to it (and any other late tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_plans TO darex_app;

-- Keep the app role's privilege set complete for any tables added after the
-- original grant without forcing a per-table migration.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
