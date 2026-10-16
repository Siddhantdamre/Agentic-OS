-------------------------------------------------------------------------------
-- Fix seed_default_autonomy_rules RLS isolation — Migration 030
--
-- Migration 023 introduced trg_orgs_seed_autonomy_rules which invokes
-- seed_default_autonomy_rules(NEW.id) on org insert. Because employee_autonomy_rules
-- enforces FORCE ROW LEVEL SECURITY requiring current_setting('app.current_org_id', true)::UUID = org_id,
-- and org creation runs without a session org_id set yet, the insert would violate
-- RLS with error 42501.
--
-- This migration marks seed_default_autonomy_rules as SECURITY DEFINER and sets
-- app.current_org_id locally during the seed operation so default rules seed reliably.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_default_autonomy_rules(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r RECORD;
  prev_org TEXT;
BEGIN
  -- Temporarily set app.current_org_id so RLS check passes for this org
  prev_org := current_setting('app.current_org_id', true);
  PERFORM set_config('app.current_org_id', p_org_id::TEXT, true);

  FOR r IN
    SELECT * FROM (VALUES
      ('read_*',                 1, 'reversible',   FALSE),
      ('search_*',               1, 'reversible',   FALSE),
      ('list_*',                 1, 'reversible',   FALSE),
      ('create_task',            3, 'reversible',   FALSE),
      ('assign_owner',           3, 'reversible',   FALSE),
      ('update_field',           3, 'reversible',   FALSE),
      ('update_status',          4, 'reversible',   FALSE),
      ('send_internal_reminder', 4, 'reversible',   FALSE),
      ('answer_faq',             4, 'reversible',   FALSE),
      ('draft_email',            2, 'reversible',   TRUE),
      ('prepare_brief',          2, 'reversible',   FALSE),
      ('recommend_merge',        2, 'reversible',   TRUE),
      ('reschedule_appointment', 3, 'visible',      FALSE),
      ('send_external_email',    2, 'visible',      TRUE),
      ('send_external_message',  2, 'visible',      TRUE),
      ('refund_payment',         2, 'irreversible', TRUE),
      ('delete_record',          2, 'irreversible', TRUE)
    ) AS t(action_type, autonomy_tier, reversibility, requires_human_approval)
  LOOP
    INSERT INTO employee_autonomy_rules
      (org_id, action_type, autonomy_tier, reversibility, requires_human_approval)
    SELECT p_org_id, r.action_type, r.autonomy_tier, r.reversibility, r.requires_human_approval
    WHERE NOT EXISTS (
      SELECT 1 FROM employee_autonomy_rules
      WHERE org_id = p_org_id
        AND action_type = r.action_type
        AND employee_role IS NULL
    );
  END LOOP;

  -- Restore previous org setting if any
  IF prev_org IS NOT NULL AND prev_org <> '' THEN
    PERFORM set_config('app.current_org_id', prev_org, true);
  ELSE
    PERFORM set_config('app.current_org_id', '', true);
  END IF;
END;
$$;
