-- 030_fix_seed_autonomy_security_definer.sql
-- Fix seed_default_autonomy_rules trigger execution so it runs as SECURITY DEFINER
-- and sets app.current_org_id during org creation, avoiding RLS policy violations.

CREATE OR REPLACE FUNCTION seed_default_autonomy_rules(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_prev_org text;
BEGIN
  v_prev_org := NULLIF(current_setting('app.current_org_id', true), '');
  PERFORM set_config('app.current_org_id', p_org_id::text, true);

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

  IF v_prev_org IS NOT NULL THEN
    PERFORM set_config('app.current_org_id', v_prev_org, true);
  ELSE
    PERFORM set_config('app.current_org_id', '', true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_orgs_seed_autonomy_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_default_autonomy_rules(NEW.id);
  RETURN NEW;
END;
$$;

-- Re-attach trigger
DROP TRIGGER IF EXISTS trg_orgs_seed_autonomy_rules ON orgs;
CREATE TRIGGER trg_orgs_seed_autonomy_rules
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION trg_orgs_seed_autonomy_rules();
