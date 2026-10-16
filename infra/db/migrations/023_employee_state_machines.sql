-- Employee state machines — Migration 023 (canonical gap/12 DDL)

-------------------------------------------------------------------------------
-- Employee State Machines and Autonomy — Migration 023
--
-- The persistent state layer for the three AI employees. Implements
-- docs/new-109-pg-plan/gap/10 P1-DB-* and the design decisions in gap/11.
-- Additive only.
--
-- Supersedes the draft DDL in gap/05 §4 (wrong table refs, missing the
-- columns 11 requires).
--
-- Tenancy: RLS ENABLE + FORCE with USING + WITH CHECK on every table,
-- grants to darex_app, same shape as 022.
--
-- File: infra/db/migrations/023_employee_state_machines.sql
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- 1. operational_enquiries — the enquiry lifecycle state machine
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operational_enquiries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,
  external_sender_id  TEXT NOT NULL,
  conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
  entity_id           UUID REFERENCES entities(id) ON DELETE SET NULL,
  customer_name       TEXT,
  company_name        TEXT,
  intent_category     TEXT NOT NULL,
  priority            TEXT NOT NULL DEFAULT 'medium',
  state               TEXT NOT NULL DEFAULT 'new',
  assigned_owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  sla_expires_at      TIMESTAMPTZ,
  last_contacted_at   TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operational_enquiries_state_chk CHECK (
    state IN ('new','assigned','contacted','overdue','escalated','closed')
  ),
  CONSTRAINT operational_enquiries_priority_chk CHECK (
    priority IN ('critical','high','medium','low')
  ),
  -- a closed enquiry has a close time; an open one does not. keeps
  -- "how long was this open" answerable without scanning an event log.
  CONSTRAINT operational_enquiries_closed_chk CHECK (
    (state = 'closed') = (closed_at IS NOT NULL)
  )
);

-- the sweep index: workflows poll for overdue work by (org, state, deadline).
CREATE INDEX IF NOT EXISTS idx_operational_enquiries_sweep
  ON operational_enquiries (org_id, state, sla_expires_at)
  WHERE state NOT IN ('closed');
CREATE INDEX IF NOT EXISTS idx_operational_enquiries_entity
  ON operational_enquiries (org_id, entity_id) WHERE entity_id IS NOT NULL;

ALTER TABLE operational_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_enquiries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operational_enquiries_org_isolation ON operational_enquiries;
CREATE POLICY operational_enquiries_org_isolation ON operational_enquiries
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON operational_enquiries TO darex_app;

COMMENT ON TABLE operational_enquiries IS
  'Enquiry lifecycle state machine. Transitions are enforced in application '
  'code by assertTransition() — the CHECK only constrains the value set.';

-------------------------------------------------------------------------------
-- 2. agent_open_loops — obligations the employee owes or is waiting on
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_open_loops (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                 UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id        UUID REFERENCES conversations(id) ON DELETE SET NULL,
  entity_id              UUID REFERENCES entities(id) ON DELETE SET NULL,
  customer_identifier    TEXT NOT NULL,

  -- 11 §2: who owes it. same sentence, opposite behaviour, so never inferred
  -- loosely and never nullable.
  obligor                TEXT NOT NULL,
  promise_summary        TEXT NOT NULL,

  -- 11 §2: the source span. required, and the extractor rejects any value
  -- that is not a substring of the source message. cheapest hallucination
  -- guard in the system.
  source_quote           TEXT NOT NULL,
  source_message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,

  status                 TEXT NOT NULL DEFAULT 'waiting',
  target_check_at        TIMESTAMPTZ NOT NULL,

  -- 11 §2: how the deadline was arrived at. drives how firmly we chase —
  -- a 'default' deadline was invented by us and the follow-up says so.
  due_basis              TEXT NOT NULL,

  assigned_employee_role TEXT NOT NULL,
  confidence             NUMERIC(4,3) NOT NULL DEFAULT 1.000,

  -- 11 §2: sha256(org_id || conversation_id || normalized_action || obligor).
  -- content hash, NOT message id — ids differ across redelivery and edits.
  content_hash           TEXT NOT NULL,

  chase_count            INTEGER NOT NULL DEFAULT 0,
  resolution_notes       TEXT,
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_open_loops_obligor_chk CHECK (obligor IN ('us','them')),
  CONSTRAINT agent_open_loops_status_chk CHECK (
    status IN ('waiting','scheduled','monitoring','escalated','closed')
  ),
  CONSTRAINT agent_open_loops_due_basis_chk CHECK (
    due_basis IN ('explicit','relative','default')
  ),
  CONSTRAINT agent_open_loops_confidence_chk CHECK (
    confidence >= 0 AND confidence <= 1
  )
);

-- the idempotency guard. re-extracting the same promise is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_open_loops_content
  ON agent_open_loops (org_id, content_hash);
-- the sweep index: OpenLoopMonitorWorkflow polls exactly this shape.
CREATE INDEX IF NOT EXISTS idx_agent_open_loops_due
  ON agent_open_loops (org_id, status, target_check_at)
  WHERE status NOT IN ('closed');

ALTER TABLE agent_open_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_open_loops FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_open_loops_org_isolation ON agent_open_loops;
CREATE POLICY agent_open_loops_org_isolation ON agent_open_loops
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_open_loops TO darex_app;

COMMENT ON TABLE agent_open_loops IS
  'Promises made to or by the org, with a due time and a source quote. '
  'The Customer Employee acts on these; they also seed operational_'
  'expectations (11 §5 generator 1).';

-------------------------------------------------------------------------------
-- 3. operational_expectations — expected vs actual
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operational_expectations (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  object_type             TEXT NOT NULL,
  object_id               TEXT NOT NULL,
  expected_state          TEXT NOT NULL,
  expected_by_timestamp   TIMESTAMPTZ NOT NULL,
  actual_state            TEXT NOT NULL DEFAULT 'pending',

  -- 11 §5: where this expectation came from. an owner reacts very differently
  -- to a broken promise than to a violated statistical guess, and the brief
  -- must word them differently.
  basis                   TEXT NOT NULL,
  source_loop_id          UUID REFERENCES agent_open_loops(id) ON DELETE SET NULL,

  is_discrepancy          BOOLEAN NOT NULL DEFAULT FALSE,
  discrepancy_magnitude   TEXT,          -- human-readable delta for the card
  work_item_id            UUID REFERENCES work_items(id) ON DELETE SET NULL,
  discrepancy_resolved_at TIMESTAMPTZ,
  settled_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operational_expectations_basis_chk CHECK (
    basis IN ('promise','declared','inferred')
  )
);

-- the detector index.
CREATE INDEX IF NOT EXISTS idx_operational_expectations_open
  ON operational_expectations (org_id, is_discrepancy, expected_by_timestamp)
  WHERE settled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_operational_expectations_object
  ON operational_expectations (org_id, object_type, object_id, expected_state)
  WHERE settled_at IS NULL;

ALTER TABLE operational_expectations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_expectations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operational_expectations_org_isolation ON operational_expectations;
CREATE POLICY operational_expectations_org_isolation ON operational_expectations
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON operational_expectations TO darex_app;

COMMENT ON TABLE operational_expectations IS
  'What should be true by when, and what actually is. An empty table makes '
  'the whole comparator a silent no-op — see 11 §5 for the three generators '
  'that must populate it.';

-------------------------------------------------------------------------------
-- 4. agent_decision_ledger — including the decisions NOT to act
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_decision_ledger (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                 UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_role          TEXT NOT NULL,
  action_considered      TEXT NOT NULL,
  decision               TEXT NOT NULL,

  -- 11 §6: enum, not prose. prose cannot be aggregated, and the aggregate
  -- ("37% of declines were missing_connector_scope") is the product roadmap.
  reason_code            TEXT NOT NULL,
  reason_summary         TEXT NOT NULL,

  confidence_score       NUMERIC(4,3) NOT NULL,
  -- 11 §3: the four terms, stored. without them quarterly calibration is
  -- impossible and explain() degrades to "confidence was low".
  confidence_breakdown   JSONB,

  entity_id              UUID REFERENCES entities(id) ON DELETE SET NULL,
  work_item_id           UUID REFERENCES work_items(id) ON DELETE SET NULL,
  autonomy_tier          INTEGER,
  context_payload        JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_decision_ledger_decision_chk CHECK (
    decision IN ('executed','deferred','declined','escalated','suppressed')
  ),
  CONSTRAINT agent_decision_ledger_confidence_chk CHECK (
    confidence_score >= 0 AND confidence_score <= 1
  )
);

-- explain() queries: newest-first per org, and per entity.
CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_recent
  ON agent_decision_ledger (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_entity
  ON agent_decision_ledger (org_id, entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL;
-- the aggregate that drives the roadmap.
CREATE INDEX IF NOT EXISTS idx_agent_decision_ledger_reason
  ON agent_decision_ledger (org_id, reason_code, created_at DESC);

ALTER TABLE agent_decision_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_decision_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_decision_ledger_org_isolation ON agent_decision_ledger;
CREATE POLICY agent_decision_ledger_org_isolation ON agent_decision_ledger
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_decision_ledger TO darex_app;

COMMENT ON TABLE agent_decision_ledger IS
  'Every gate evaluation, acted on or not. The negatives are the point: an '
  'action log answers "what did you do", but every trust question is about '
  'something that did NOT happen. Cannot be retrofitted. 90d full retention, '
  'then roll up to daily (reason_code, action) counts — never sample recent.';

-------------------------------------------------------------------------------
-- 5. employee_autonomy_rules — the declarative tier matrix
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_autonomy_rules (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  action_type             TEXT NOT NULL,
  -- NULL = applies to every employee role. 11 §10 Q3: org-wide at launch.
  employee_role           TEXT,
  autonomy_tier           INTEGER NOT NULL,

  -- 11 §1: the dominant term in the escalation score. irreversible actions
  -- are never exempted by confidence or by approval history.
  reversibility           TEXT NOT NULL DEFAULT 'reversible',

  requires_human_approval BOOLEAN NOT NULL DEFAULT FALSE,
  confidence_threshold    NUMERIC(4,3) NOT NULL DEFAULT 0.850,
  escalation_threshold    NUMERIC(4,3) NOT NULL DEFAULT 0.150,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_autonomy_rules_tier_chk CHECK (
    autonomy_tier BETWEEN 1 AND 4
  ),
  CONSTRAINT employee_autonomy_rules_reversibility_chk CHECK (
    reversibility IN ('reversible','visible','irreversible')
  ),
  -- an irreversible action always asks. enforced in the schema so no seed
  -- row, admin edit, or migration can quietly create an auto-refund path.
  CONSTRAINT employee_autonomy_rules_irreversible_chk CHECK (
    reversibility <> 'irreversible' OR requires_human_approval = TRUE
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_autonomy_rules_action
  ON employee_autonomy_rules (org_id, action_type, COALESCE(employee_role, '*'));

ALTER TABLE employee_autonomy_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_autonomy_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_autonomy_rules_org_isolation ON employee_autonomy_rules;
CREATE POLICY employee_autonomy_rules_org_isolation ON employee_autonomy_rules
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_autonomy_rules TO darex_app;

COMMENT ON TABLE employee_autonomy_rules IS
  'Per-action autonomy policy. One input to the escalation score (11 §1), '
  'not the whole answer — blast radius of the specific instance and '
  'confidence also decide.';

-------------------------------------------------------------------------------
-- 6. agent_pending_actions — parked work awaiting a human
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_pending_actions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  workflow_id    TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  employee_role  TEXT NOT NULL,
  payload        JSONB NOT NULL,
  -- sha256 of the raw token. the raw value is handed to the dashboard once
  -- and never stored.
  token_hash     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  work_item_id   UUID REFERENCES work_items(id) ON DELETE SET NULL,
  -- 11 §10 Q5: timeout must NEVER mean approve. on expiry: ledger it,
  -- notify once, leave it unexecuted.
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  decided_at     TIMESTAMPTZ,
  decided_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_pending_actions_status_chk CHECK (
    status IN ('pending','approved','rejected','expired')
  ),
  CONSTRAINT agent_pending_actions_decided_chk CHECK (
    (status = 'pending') = (decided_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_pending_actions_token
  ON agent_pending_actions (token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_open
  ON agent_pending_actions (org_id, status, expires_at) WHERE status = 'pending';

ALTER TABLE agent_pending_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pending_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_pending_actions_org_isolation ON agent_pending_actions;
CREATE POLICY agent_pending_actions_org_isolation ON agent_pending_actions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_pending_actions TO darex_app;

COMMENT ON TABLE agent_pending_actions IS
  'Actions parked by the autonomy gate. Resumed by signalling the Temporal '
  'workflow named in workflow_id. Expiry never approves.';

-------------------------------------------------------------------------------
-- 7. agent_entity_leases — multi-employee collision control (11 §8)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_entity_leases (
  org_id         UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_key     TEXT NOT NULL,
  employee_role  TEXT NOT NULL,
  workflow_id    TEXT NOT NULL,
  -- advisory and SHORT. a stuck lease must never freeze an entity, so a
  -- second employee that sees a live lease reschedules rather than blocks.
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_entity_leases_expiry
  ON agent_entity_leases (expires_at);

ALTER TABLE agent_entity_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_entity_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_entity_leases_org_isolation ON agent_entity_leases;
CREATE POLICY agent_entity_leases_org_isolation ON agent_entity_leases
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_entity_leases TO darex_app;

COMMENT ON TABLE agent_entity_leases IS
  'Advisory short leases so two employees do not act on one entity at once. '
  'Precedence when contested: customer > operations > growth.';

-------------------------------------------------------------------------------
-- 8. agent_outbound_budget — org-wide per-customer send cap (11 §8)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_outbound_budget (
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  customer_key TEXT NOT NULL,
  window_date  DATE NOT NULL,
  sent_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, customer_key, window_date)
);

ALTER TABLE agent_outbound_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_outbound_budget FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_outbound_budget_org_isolation ON agent_outbound_budget;
CREATE POLICY agent_outbound_budget_org_isolation ON agent_outbound_budget
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_outbound_budget TO darex_app;

COMMENT ON TABLE agent_outbound_budget IS
  'Counted across ALL employees, not per employee. Three employees each '
  'politely sending one message is three messages from one company in one '
  'day, and the customer reads that as spam.';

-------------------------------------------------------------------------------
-- 9. agent_preference_suppressions — learned rejections (11 §7)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_preference_suppressions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_role   TEXT NOT NULL,
  -- the dimension the owner actually rejected on, from the one-tap reason.
  -- suppress along this axis ONLY.
  dimension       TEXT NOT NULL,
  pattern_key     TEXT NOT NULL,
  rejection_count INTEGER NOT NULL DEFAULT 1,
  -- 11 §7: ~90 day half-life. a rejection from eight months ago must not
  -- silence a card today.
  weight          NUMERIC(4,3) NOT NULL DEFAULT 1.000,
  last_rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- visible and removable in settings. a silent unremovable filter is
  -- indistinguishable from a broken product.
  dismissed_by_user BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_preference_suppressions_dimension_chk CHECK (
    dimension IN ('fit','timing','channel','snooze')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_preference_suppressions
  ON agent_preference_suppressions (org_id, employee_role, dimension, pattern_key);

ALTER TABLE agent_preference_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_preference_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_preference_suppressions_org_isolation ON agent_preference_suppressions;
CREATE POLICY agent_preference_suppressions_org_isolation ON agent_preference_suppressions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_preference_suppressions TO darex_app;

COMMENT ON TABLE agent_preference_suppressions IS
  'Learned "stop showing me this". Decays. Never silences more than ~70% of '
  'candidates — hitting that floor means the preference model is wrong, not '
  'that the owner wants silence.';

-------------------------------------------------------------------------------
-- 10. pg_trgm for fuzzy dedup (P3-DEDUP-1)
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-------------------------------------------------------------------------------
-- 11. Seed default autonomy rules (P1-DB-5)
-- Insert at org create so irreversible actions cannot skip approval.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION seed_default_autonomy_rules(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
BEGIN
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
END;
$$;

CREATE OR REPLACE FUNCTION trg_orgs_seed_autonomy_rules()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM seed_default_autonomy_rules(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orgs_seed_autonomy_rules ON orgs;
CREATE TRIGGER trg_orgs_seed_autonomy_rules
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION trg_orgs_seed_autonomy_rules();

SELECT seed_default_autonomy_rules(id) FROM orgs;
