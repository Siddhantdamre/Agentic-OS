-- A SELF-DIRECTED TURN'S TOOL GRANT, READABLE BY THE PROCESS THAT ENFORCES IT.
--
-- `duties.ts` declares in its own header:
--
--   "A DUTY RUNS WITH THE MINIMUM TOOL, NOT THE EMPLOYEE'S FULL AUTHORITY.
--    Sarah holds gmail, whatsapp, hubspot and a calendar. Her duty runs with
--    `database_query` alone."
--
-- `planDuty` computes that correctly and `duties.test.ts` asserts it. Then the
-- value is passed into the workflow and DISCARDED: the MCP bridge calls
-- `executeAutonomousToolAction` with no allowlist, so it falls back to
-- `resolveOrgToolAllowlist` — the union of every active employee's tools plus
-- every connected channel.
--
-- Measured on a real shift. Emma's duty, whose allowlist is `["database_query"]`,
-- reached `metrics_list`, `metrics_query` and `intercom_fetch_conversations`.
-- Intercom is not in her employee allowlist and is not connected in that
-- workspace; the org union let it through because some other employee holds it
-- and the call is a read.
--
-- The security floor did hold — verified directly, every send/pay/write is
-- refused with `no_employee_named` — so this was least-privilege erosion, not a
-- breach. But an invariant enforced only where it is computed is an invariant
-- that will be wrong the moment somebody changes the other end.
--
-- ── WHY A TABLE AND NOT A PARAMETER ─────────────────────────────────────────
--
-- The bridge is a separate process. The only thing that crosses it from the
-- host — rather than from the model — is the session id, which already carries
-- the tenant (patch 0001) and the model (patch 0002). Patch 0003 forwards it on
-- every MCP tool call, and the bridge looks the grant up here.
--
-- Keyed by session, not by org: several duties for one workspace dispatch within
-- the same second, and an org-keyed narrowing would apply Emma's grant to
-- Marcus's turn.
--
-- FAILS OPEN TO TODAY'S BEHAVIOUR, DELIBERATELY. No row, or an expired row,
-- means the bridge does exactly what it does now: the org union, reads only. A
-- grant can therefore only ever narrow. The alternative — treating a missing
-- grant as "deny" — would turn a stale row or a clock skew into an outage on
-- customer conversations, which is a worse failure than the one being fixed.

CREATE TABLE IF NOT EXISTS duty_turn_grants (
  -- The namespaced session id the host built: `darex:<org>:<key>[:m=<model>]`.
  session_id   TEXT PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id  UUID,
  -- The duty's need intersected with what the employee holds. Never the union.
  allowlist    TEXT[] NOT NULL,
  -- Short by design: a turn is minutes, and an abandoned grant must stop
  -- restricting anything rather than linger.
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The bridge's only read: one session, still valid.
CREATE INDEX IF NOT EXISTS duty_turn_grants_live_idx
  ON duty_turn_grants (session_id, expires_at);

-- For the sweep, and for answering "what is narrowed right now" per workspace.
CREATE INDEX IF NOT EXISTS duty_turn_grants_org_idx
  ON duty_turn_grants (org_id, expires_at);

-- Row-level security, like every other tenant table here. The bridge reads with
-- an org-scoped client, so a grant is invisible outside its own workspace —
-- which matters because the session id is the lookup key and session ids are
-- guessable in shape.
ALTER TABLE duty_turn_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS duty_turn_grants_org_isolation ON duty_turn_grants;
CREATE POLICY duty_turn_grants_org_isolation ON duty_turn_grants
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON duty_turn_grants TO darex_app;
