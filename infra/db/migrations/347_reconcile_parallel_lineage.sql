-- 347: bring the tables and functions from the parallel lineage (migrations 322-346) up to this lineage's hardening.
--
-- WHY
-- Migrations 322-346 came from a second history of this project that was merged in. They create real features
-- (outcome ledger, knowledge gaps, commitments, earned autonomy, LLM budget, erasure, contact identity, task
-- supervision) but were written before the isolation rules in 207 and 037. Measured on a database with every
-- migration applied, as the application role:
--   * the view outcome_lift ran with its owner's rights and returned another workspace's rows;
--   * duty_turn_grants had row-level security enabled but not forced;
--   * record_knowledge_gap, record_reply_edit and resolve_knowledge_gap were SECURITY DEFINER without a pinned
--     search_path;
--   * the model-SQL reader role could execute SECURITY DEFINER functions and had no decision on the new tables.
--
-- WHAT THIS DOES (idempotent)
--   1. every view in public becomes security_invoker, so the base tables' policies apply to the caller;
--   2. duty_turn_grants is forced;
--   3. every SECURITY DEFINER function pins search_path;
--   4. SECURITY DEFINER functions are executable only by darex and darex_app (not PUBLIC, so not the reader role);
--   5. the reader role may read operational settings tables; it is NOT given tables that hold what customers said or
--      who they are (listed in check-rls-coverage.js as withheld).

DO $$
DECLARE
  v RECORD;
BEGIN
  FOR v IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND NOT COALESCE('security_invoker=true' = ANY (c.reloptions), FALSE)
  LOOP
    EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', v.relname);
  END LOOP;
END
$$;

ALTER TABLE IF EXISTS duty_turn_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS duty_turn_grants FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  f RECORD;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
END
$$;

DO $$
DECLARE
  f RECORD;
  grantees TEXT := 'darex, darex_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'darex_platform') THEN
    grantees := grantees || ', darex_platform';
  END IF;
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', f.sig, grantees);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END
$$;

-- Operational settings and counters: no customer content.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_action_autonomy', 'org_automation', 'org_llm_budget', 'org_llm_usage_daily',
                            'org_retention_policy', 'org_shadow_mode', 'trigger_dispatches', 'duty_turn_grants',
                            'action_outcomes']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO darex_sql_reader', t);
    END IF;
  END LOOP;
END
$$;
