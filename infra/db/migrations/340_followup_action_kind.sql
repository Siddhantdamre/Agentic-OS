-- 040: let the ledger record work the agent STARTED, not only work it answered.
--
-- WHY
-- agent_actions.action_kind was constrained to:
--
--     reply_sent | tool_executed | plan_executed | escalated | no_action
--
-- Every one of those describes responding to something. Measured before this
-- migration: 716 recorded actions, 716 of them `reply_sent`. The system had
-- literally no vocabulary for the agent doing something first, because it had
-- never done anything first.
--
-- Recording a follow-up as `reply_sent` would have been the easy fix and the
-- wrong one: it would erase the exact distinction this work exists to create,
-- and the query "what has the agent done that nobody asked for?" would return
-- nothing forever while the feature ran.
--
-- ── ON `arm` ──────────────────────────────────────────────────────────────
-- agent_actions already carries arm ∈ (treatment, holdout). That is the honest
-- way to measure a follow-up: some quiet leads are deliberately NOT contacted,
-- and the reply rate of the contacted group is only meaningful against them.
-- Without a holdout, "9 of 40 replied" cannot distinguish a follow-up that
-- worked from 9 people who were going to come back anyway.
--
-- This migration does not implement the holdout — it records the arm so that
-- when one is switched on, the history is already shaped to answer the
-- question. Follow-ups default to 'treatment'.

-- Drop whatever the existing action_kind check is actually CALLED, rather than
-- guessing its name. The first version of this migration dropped
-- "agent_actions_action_kind_check", which does not exist — the real name is
-- "agent_actions_kind_chk". Postgres accepted the DROP IF EXISTS silently, the
-- ADD succeeded, and the ORIGINAL constraint stayed in force, so the migration
-- reported success and changed nothing. A rename in either direction would
-- reintroduce that, so the name is discovered instead of assumed.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'agent_actions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%action_kind%'
  LOOP
    EXECUTE format('ALTER TABLE agent_actions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_kind_chk
  CHECK (action_kind = ANY (ARRAY[
    'reply_sent',
    'tool_executed',
    'plan_executed',
    'escalated',
    'no_action',
    -- The agent contacted someone who had gone quiet. Nobody asked it to.
    'followup_sent',
    -- It decided a lead should be contacted and a human has not yet agreed.
    'followup_proposed'
  ]));

COMMENT ON COLUMN agent_actions.action_kind IS
  'What the agent did. followup_sent and followup_proposed are the first kinds '
  'that are not a response to an inbound message — see migration 039.';
