/**
 * Outcome ledger activities — materialize actions/outcomes, then attribute.
 *
 * Reads only tables that already exist (messages, conversations, channel_logs,
 * ask_ai_feedback) and writes the ledger from migration 022. Nothing here
 * invents data: every row carries (source_table, source_id) back to its origin.
 *
 * IDEMPOTENT BY CONSTRUCTION. Temporal retries and overlapping backfill windows
 * are normal, so every insert is ON CONFLICT DO NOTHING against the UNIQUE keys
 * in 022. Re-running over the same window must not change any number — the
 * moment it does, a customer's reported ROI depends on how often a cron fired.
 *
 * All queries run under RLS with app.current_org_id set, on the least-privilege
 * darex_app role. There is no cross-org read path in this file.
 */

import { Pool, PoolClient } from 'pg';
import {
  attributeOutcomes,
  summarize,
  DEFAULT_WINDOW_SECONDS,
  type AgentActionInput,
  type OutcomeEventInput,
  type LedgerSummary,
} from '../outcomes/attribution';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
  max: 5,
});

/** Run `fn` with the org's RLS scope set, always releasing the client. */
async function withOrgScope<T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // fall through — releasing the client matters more than resetting a GUC
    }
    client.release();
  }
}

export interface LedgerWindowInput {
  orgId: string;
  /** ISO timestamps bounding the window to materialize. */
  since: string;
  until: string;
  /** Attribution window; defaults to 24h. */
  windowSeconds?: number;
  /** Enable org-level correlation edges. Off by default, deliberately. */
  allowWeak?: boolean;
  /** 0–100. 0 (default) means no control group is created. */
  holdoutPercent?: number;
  experimentKey?: string;
}

export interface LedgerRunResult {
  orgId: string;
  actionsIngested: number;
  outcomesIngested: number;
  edgesWritten: number;
  summary: LedgerSummary;
  /**
   * True when a holdout arm exists for this window. When false, consumers MUST
   * present results as correlation — there is no control to compare against.
   */
  causalComparisonAvailable: boolean;
}

/**
 * Materialize agent actions from existing tables.
 *
 * Assistant messages are the agent's visible actions; channel_logs proxy_call
 * rows are its tool executions. Both are keyed by their source row id, so the
 * same underlying event can never produce two ledger rows.
 */
async function ingestActions(
  client: PoolClient,
  input: LedgerWindowInput
): Promise<number> {
  const { orgId, since, until } = input;

  // Assistant replies → 'reply_sent'.
  const replies = await client.query(
    `INSERT INTO agent_actions
       (org_id, conversation_id, employee_id, action_kind, source_table, source_id, occurred_at, metadata)
     SELECT
       m.org_id,
       m.conversation_id,
       c.employee_id,
       'reply_sent',
       'messages',
       m.id::text,
       m.created_at,
       jsonb_build_object('role', m.role)
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
     WHERE m.org_id = $1
       AND m.role = 'assistant'
       AND m.created_at >= $2::timestamptz
       AND m.created_at <  $3::timestamptz
     ON CONFLICT (org_id, source_table, source_id, action_kind) DO NOTHING`,
    [orgId, since, until]
  );

  // Successful connector calls → 'tool_executed'. Failures are not actions the
  // agent "did" for the customer; counting them would inflate the denominator
  // with work that never reached anyone.
  const tools = await client.query(
    `INSERT INTO agent_actions
       (org_id, conversation_id, action_kind, source_table, source_id, occurred_at, metadata)
     SELECT
       cl.org_id,
       NULL,
       'tool_executed',
       'channel_logs',
       cl.id::text,
       cl.created_at,
       jsonb_build_object('channel_type', cl.channel_type, 'event_type', cl.event_type)
     FROM channel_logs cl
     WHERE cl.org_id = $1
       AND cl.event_type = 'proxy_call'
       AND cl.status = 'success'
       AND cl.created_at >= $2::timestamptz
       AND cl.created_at <  $3::timestamptz
     ON CONFLICT (org_id, source_table, source_id, action_kind) DO NOTHING`,
    [orgId, since, until]
  );

  /**
   * Duty runs → 'duty_run', attributed to the employee that ran it.
   *
   * An employee's standing duty produces an AGENT_EXECUTION log and no message,
   * because a duty is not a customer conversation and must not be persisted as
   * one. Neither branch above ingested it: replies come from `messages`, tools
   * from `proxy_call`. So six employees ran their duties three times each, all
   * eighteen runs were logged with the employee's name, and `agent_actions`
   * held none of them — which meant the employee detail page, whose entire job
   * is showing what an employee did, showed nothing for any of it.
   *
   * Only successful runs count, matching the rule for tools above: a failed
   * duty is not work the employee did. `succeeded` is written by
   * AutonomousAgentWorkflow, which now treats an empty reply as a failure.
   *
   * employee_id comes from the payload, never a join on name — there are 52
   * employees called "Sarah" in this database, so a name is not an identity.
   */
  const duties = await client.query(
    `INSERT INTO agent_actions
       (org_id, conversation_id, employee_id, action_kind, source_table, source_id, occurred_at, metadata)
     SELECT
       cl.org_id,
       NULL,
       (cl.payload->>'employeeId')::uuid,
       'duty_run',
       'channel_logs',
       cl.id::text,
       cl.created_at,
       jsonb_build_object(
         'employeeName', cl.payload->>'employeeName',
         'usedTools',    COALESCE(cl.payload->'usedTools', '[]'::jsonb),
         'stepsCount',   COALESCE(cl.payload->>'stepsCount', '0')
       )
     FROM channel_logs cl
     WHERE cl.org_id = $1
       AND cl.event_type = 'AGENT_EXECUTION'
       AND cl.payload->>'selfDirected' = 'true'
       AND cl.payload->>'succeeded' = 'true'
       AND cl.payload->>'employeeId' IS NOT NULL
       AND cl.created_at >= $2::timestamptz
       AND cl.created_at <  $3::timestamptz
     ON CONFLICT (org_id, source_table, source_id, action_kind) DO NOTHING`,
    [orgId, since, until]
  );

  return (replies.rowCount ?? 0) + (tools.rowCount ?? 0) + (duties.rowCount ?? 0);
}

/**
 * Materialize observed outcomes.
 *
 * Includes ask_ai_feedback, which until now was collected and never read —
 * explicit human judgement is the highest-quality signal available and it was
 * going to waste.
 */
async function ingestOutcomes(
  client: PoolClient,
  input: LedgerWindowInput
): Promise<number> {
  const { orgId, since, until } = input;
  let total = 0;

  // Customer replies.
  const replies = await client.query(
    `INSERT INTO outcome_events
       (org_id, conversation_id, outcome_kind, occurred_at, source_table, source_id, metadata)
     SELECT
       m.org_id, m.conversation_id, 'customer_replied', m.created_at,
       'messages', m.id::text, jsonb_build_object('role', m.role)
     FROM messages m
     WHERE m.org_id = $1
       AND m.role IN ('user', 'customer')
       AND m.created_at >= $2::timestamptz
       AND m.created_at <  $3::timestamptz
     ON CONFLICT (org_id, source_table, source_id, outcome_kind) DO NOTHING`,
    [orgId, since, until]
  );
  total += replies.rowCount ?? 0;

  // Resolved conversations.
  const resolved = await client.query(
    `INSERT INTO outcome_events
       (org_id, conversation_id, outcome_kind, occurred_at, source_table, source_id, metadata)
     SELECT
       c.org_id, c.id, 'conversation_resolved', c.resolved_at,
       'conversations', c.id::text, jsonb_build_object('status', c.status)
     FROM conversations c
     WHERE c.org_id = $1
       AND c.resolved_at IS NOT NULL
       AND c.resolved_at >= $2::timestamptz
       AND c.resolved_at <  $3::timestamptz
     ON CONFLICT (org_id, source_table, source_id, outcome_kind) DO NOTHING`,
    [orgId, since, until]
  );
  total += resolved.rowCount ?? 0;

  // A human stepping in AFTER the agent had already replied. This is the
  // ledger's most important NEGATIVE signal, and nothing was recording it:
  // outcome_events has allowed 'human_took_over' since migration 022 and no
  // code ever inserted one.
  //
  // Without it the ledger can only count successes, and a measurement that
  // moves in one direction is not a measurement. "91% handled without a human"
  // only means something because the other 9% is counted here.
  //
  // A PRIOR assistant message is required. A human answering a thread the
  // agent never touched is ordinary work, not a takeover, and counting it
  // would blame the agent for conversations it was never given.
  const takeover = await client.query(
    `INSERT INTO outcome_events
       (org_id, conversation_id, outcome_kind, occurred_at, source_table, source_id, metadata)
     SELECT
       h.org_id, h.conversation_id, 'human_took_over', h.created_at,
       'messages', h.id::text, jsonb_build_object('role', h.role)
     FROM messages h
     WHERE h.org_id = $1
       AND h.role = 'human_agent'
       AND h.created_at >= $2::timestamptz
       AND h.created_at <  $3::timestamptz
       AND EXISTS (
         SELECT 1 FROM messages a
          WHERE a.org_id = h.org_id
            AND a.conversation_id = h.conversation_id
            AND a.role = 'assistant'
            AND a.created_at < h.created_at
       )
     ON CONFLICT (org_id, source_table, source_id, outcome_kind) DO NOTHING`,
    [orgId, since, until]
  );
  total += takeover.rowCount ?? 0;

  // Explicit thumbs. Negative votes are ingested exactly like positive ones —
  // a ledger that only records praise is worthless for improving anything.
  // Tolerated as optional: ask_ai_feedback ships in migration 020, and this
  // activity must not hard-fail on a database that predates it.
  try {
    const feedback = await client.query(
      `INSERT INTO outcome_events
         (org_id, conversation_id, outcome_kind, occurred_at, source_table, source_id, metadata)
       SELECT
         f.org_id,
         f.conversation_id,
         CASE WHEN f.vote = 'up' THEN 'feedback_positive' ELSE 'feedback_negative' END,
         f.created_at,
         'ask_ai_feedback',
         f.id::text,
         jsonb_build_object('vote', f.vote)
       FROM ask_ai_feedback f
       WHERE f.org_id = $1
         AND f.created_at >= $2::timestamptz
         AND f.created_at <  $3::timestamptz
       ON CONFLICT (org_id, source_table, source_id, outcome_kind) DO NOTHING`,
      [orgId, since, until]
    );
    total += feedback.rowCount ?? 0;
  } catch (err: any) {
    if (!/does not exist/i.test(String(err?.message)) || !String(err?.message).includes('ask_ai_feedback')) {
      throw err;
    }
  }

  return total;
}

/**
 * Materialize the window, attribute it, and persist the edges.
 *
 * Attribution reads a slightly wider action window than the outcome window
 * (back by windowSeconds) so an outcome near the start boundary can still find
 * the action that preceded it. Without that overlap, every run would silently
 * under-attribute at its own edges.
 */
export async function runOutcomeLedger(input: LedgerWindowInput): Promise<LedgerRunResult> {
  const windowSeconds = input.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const allowWeak = input.allowWeak === true;

  return withOrgScope(input.orgId, async (client) => {
    const actionsIngested = await ingestActions(client, input);
    const outcomesIngested = await ingestOutcomes(client, input);

    const actionsRes = await client.query(
      `SELECT id, conversation_id, action_kind, occurred_at, arm
         FROM agent_actions
        WHERE org_id = $1
          AND occurred_at >= ($2::timestamptz - make_interval(secs => $4::double precision))
          AND occurred_at <  $3::timestamptz`,
      [input.orgId, input.since, input.until, windowSeconds]
    );
    const outcomesRes = await client.query(
      `SELECT id, conversation_id, outcome_kind, occurred_at
         FROM outcome_events
        WHERE org_id = $1
          AND occurred_at >= $2::timestamptz
          AND occurred_at <  $3::timestamptz`,
      [input.orgId, input.since, input.until]
    );

    const actions: AgentActionInput[] = actionsRes.rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      actionKind: r.action_kind,
      occurredAt: new Date(r.occurred_at).getTime(),
    }));
    const outcomes: OutcomeEventInput[] = outcomesRes.rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      outcomeKind: r.outcome_kind,
      occurredAt: new Date(r.occurred_at).getTime(),
    }));

    const edges = attributeOutcomes(actions, outcomes, { windowSeconds, allowWeak });

    let edgesWritten = 0;
    for (const edge of edges) {
      const res = await client.query(
        `INSERT INTO action_outcomes
           (org_id, action_id, outcome_id, method, strength, latency_seconds, window_seconds, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (action_id, outcome_id) DO NOTHING`,
        [
          input.orgId,
          edge.actionId,
          edge.outcomeId,
          edge.method,
          edge.strength,
          edge.latencySeconds,
          edge.windowSeconds,
          JSON.stringify(edge.evidence),
        ]
      );
      edgesWritten += res.rowCount ?? 0;
    }

    const holdoutRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM agent_actions
        WHERE org_id = $1 AND arm = 'holdout'
          AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz`,
      [input.orgId, input.since, input.until]
    );

    return {
      orgId: input.orgId,
      actionsIngested,
      outcomesIngested,
      edgesWritten,
      summary: summarize(actions, edges),
      causalComparisonAvailable: (holdoutRes.rows[0]?.n ?? 0) > 0,
    };
  });
}

export interface LiftRow {
  actionKind: string;
  outcomeKind: string | null;
  treatmentActions: number;
  treatmentRatePct: number | null;
  holdoutActions: number;
  holdoutRatePct: number | null;
  liftPp: number | null;
}

/**
 * Read the treatment-vs-holdout comparison.
 *
 * `liftPp` is NULL when no holdout exists. Callers must render that as
 * "no control group" rather than as zero — a missing measurement and a
 * measured zero are entirely different statements to a buyer.
 */
export async function readOutcomeLift(orgId: string): Promise<LiftRow[]> {
  return withOrgScope(orgId, async (client) => {
    const res = await client.query(
      `SELECT action_kind, outcome_kind,
              COALESCE(treatment_actions, 0) AS treatment_actions,
              treatment_rate_pct,
              COALESCE(holdout_actions, 0)   AS holdout_actions,
              holdout_rate_pct,
              lift_pp
         FROM outcome_lift
        WHERE org_id = $1
        ORDER BY action_kind, outcome_kind NULLS LAST`,
      [orgId]
    );
    return res.rows.map((r) => ({
      actionKind: r.action_kind,
      outcomeKind: r.outcome_kind,
      treatmentActions: Number(r.treatment_actions),
      treatmentRatePct: r.treatment_rate_pct === null ? null : Number(r.treatment_rate_pct),
      holdoutActions: Number(r.holdout_actions),
      holdoutRatePct: r.holdout_rate_pct === null ? null : Number(r.holdout_rate_pct),
      liftPp: r.lift_pp === null ? null : Number(r.lift_pp),
    }));
  });
}

export async function closeOutcomeLedgerPool(): Promise<void> {
  await pool.end();
}
