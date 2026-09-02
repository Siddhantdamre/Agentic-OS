-- 044 — allow 'duty_run' as an agent action kind.
--
-- An employee's standing duty is work it did, and it belongs in the same ledger
-- as a reply or a tool call. It could not be recorded: action_kind carries a
-- CHECK constraint listing the kinds that existed when the ledger was written,
-- and a duty is newer than that list.
--
-- The symptom was not an error anybody saw. The ledger ingests inside a
-- transaction that swallows a failed window, so six employees ran their duties
-- three times each, all eighteen runs landed in channel_logs, and
-- agent_actions held none of them — leaving /employees/[id], whose whole job is
-- showing what an employee did, blank for every one of them.
--
-- The constraint is kept rather than dropped. It is the reason a typo in an
-- action kind fails loudly instead of creating a category nothing reads, and
-- check-duty-visible.js found this exact bug by hitting it.
--
-- Idempotent: safe to re-run.

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_kind_chk;

ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_kind_chk
  CHECK (action_kind = ANY (ARRAY[
    'reply_sent',
    'tool_executed',
    'plan_executed',
    'escalated',
    'no_action',
    'followup_sent',
    'followup_proposed',
    -- New: an employee carrying out its own standing duty, unprompted.
    'duty_run'
  ]));

COMMENT ON CONSTRAINT agent_actions_kind_chk ON agent_actions IS
  'Closed vocabulary of recorded agent actions. Extend it in a migration when a '
  'new kind of work exists — never widen it to text, or a typo becomes a silent '
  'category that no dashboard reads.';
