-- 031_harden_rls_nullif_uuid.sql
-- Harden RLS policies across tenant-scoped tables to use NULLIF(current_setting('app.current_org_id', true), '')::UUID
-- This avoids "invalid input syntax for type uuid: ''" when app.current_org_id is unset or empty during user lookup.

-- 1. users
DROP POLICY IF EXISTS users_org_isolation ON users;
CREATE POLICY users_org_isolation ON users
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 2. ai_employees
DROP POLICY IF EXISTS ai_employees_org_isolation ON ai_employees;
CREATE POLICY ai_employees_org_isolation ON ai_employees
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 3. channels
DROP POLICY IF EXISTS channels_org_isolation ON channels;
CREATE POLICY channels_org_isolation ON channels
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 4. conversations
DROP POLICY IF EXISTS conversations_org_isolation ON conversations;
CREATE POLICY conversations_org_isolation ON conversations
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 5. messages
DROP POLICY IF EXISTS messages_org_isolation ON messages;
CREATE POLICY messages_org_isolation ON messages
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 6. org_onboarding
DROP POLICY IF EXISTS org_onboarding_org_isolation ON org_onboarding;
CREATE POLICY org_onboarding_org_isolation ON org_onboarding
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 7. idempotency_keys
DROP POLICY IF EXISTS idempotency_keys_org_isolation ON idempotency_keys;
CREATE POLICY idempotency_keys_org_isolation ON idempotency_keys
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 8. agent_plans
DROP POLICY IF EXISTS agent_plans_org_isolation ON agent_plans;
CREATE POLICY agent_plans_org_isolation ON agent_plans
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 9. work_items
DROP POLICY IF EXISTS work_items_org_isolation ON work_items;
CREATE POLICY work_items_org_isolation ON work_items
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 10. employee_autonomy_rules
DROP POLICY IF EXISTS employee_autonomy_rules_org_isolation ON employee_autonomy_rules;
CREATE POLICY employee_autonomy_rules_org_isolation ON employee_autonomy_rules
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 11. agent_pending_actions
DROP POLICY IF EXISTS agent_pending_actions_org_isolation ON agent_pending_actions;
CREATE POLICY agent_pending_actions_org_isolation ON agent_pending_actions
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 12. agent_decision_ledger
DROP POLICY IF EXISTS agent_decision_ledger_org_isolation ON agent_decision_ledger;
CREATE POLICY agent_decision_ledger_org_isolation ON agent_decision_ledger
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);

-- 13. operational_expectations
DROP POLICY IF EXISTS operational_expectations_org_isolation ON operational_expectations;
CREATE POLICY operational_expectations_org_isolation ON operational_expectations
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);
