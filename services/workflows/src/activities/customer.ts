import type { CustomerOperationalState, DecisionCard } from '@darex/shared-types';
import { claimIdempotent, isUndefinedTable, sideEffectKey, withOrgClient } from '../db.js';
import { contentHashFor, extractObligations, prepareObligations } from '../customer/obligation-extractor.js';
import {
  applyAccountProfileToState,
  evaluateSentimentTrend,
  inferOperationalState,
  sentimentSeverity,
} from '../customer/operational-state.js';
import { fetchAccountProfile, type AccountProfile } from '../customer/account-profile.js';
import { lowConfidenceDecisionCard } from '../customer/decision-card.js';
import { attachWorkItemCardActivity } from './work-item-card.js';
import { executeProvider } from '../tools/index.js';
import type { MessageSender } from '../untrusted.js';
import { clusterGapQuestions, type KnowledgeGapCluster } from '../customer/knowledge-gap-clusters.js';
export type { KnowledgeGapCluster } from '../customer/knowledge-gap-clusters.js';

const KNOWLEDGE_GAP_REASON_CODES = ['confidence_below_threshold', 'low_rag_no_tool'];

function asSender(role: string | undefined): MessageSender {
  switch (role) {
    case 'customer':
    case 'user':
      return 'customer';
    case 'system':
      return 'system';
    default:
      return 'employee';
  }
}

export async function persistOperationalStateActivity(input: {
  orgId: string; conversationId: string; userMessage: string; forceEscalate?: boolean;
  customerIdentifier?: string;
}): Promise<{ state: CustomerOperationalState; profile?: AccountProfile }> {
  const keywordState = inferOperationalState(input);
  let profile: AccountProfile | undefined;
  if (input.customerIdentifier) {
    try {
      profile = await fetchAccountProfile(input.orgId, input.customerIdentifier);
    } catch {
      profile = undefined;
    }
  }
  const state = applyAccountProfileToState(keywordState, profile);
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `UPDATE conversations
            SET customer_operational_state = $1,
                metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [
          state,
          input.conversationId,
          input.orgId,
          JSON.stringify(profile ? { accountProfile: profile } : {}),
        ],
      );
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
  await recordSentimentTurnAndMaybeAlert({
    orgId: input.orgId,
    conversationId: input.conversationId,
    customerIdentifier: input.customerIdentifier,
    state,
  });
  return { state, profile };
}

/**
 * CE-09 Angry Customer Radar: logs this turn's operational state to the
 * per-conversation sentiment history, then checks whether the last few turns
 * form a negative trend (not just this one message). On a trend, pushes a
 * proactive Slack alert to the rep channel — at most once per conversation
 * per day, via the existing idempotency-key claim pattern, so a customer
 * stuck at "frustrated" doesn't re-alert on every single follow-up message.
 */
async function recordSentimentTurnAndMaybeAlert(input: {
  orgId: string;
  conversationId: string;
  customerIdentifier?: string;
  state: CustomerOperationalState;
}): Promise<void> {
  const severity = sentimentSeverity(input.state);
  let recentSeverities: number[] = [];
  try {
    recentSeverities = await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO agent_sentiment_history (org_id, conversation_id, customer_identifier, state, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.orgId, input.conversationId, input.customerIdentifier || null, input.state, severity],
      );
      const res = await client.query<{ severity: number }>(
        `SELECT severity FROM agent_sentiment_history
          WHERE org_id = $1 AND conversation_id = $2
          ORDER BY created_at DESC LIMIT 5`,
        [input.orgId, input.conversationId],
      );
      return res.rows.map((row) => Number(row.severity));
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    return;
  }

  const trend = evaluateSentimentTrend(recentSeverities.map((s) => ({ severity: s })));
  if (!trend.escalate) return;

  const claim = await claimIdempotent(
    input.orgId,
    sideEffectKey(input.orgId, 'sentimentTrendAlert', input.conversationId),
  );
  if (!claim.claimed) return;

  await executeProvider({
    tool: 'slack',
    action: 'send_channel_message',
    actionName: 'send_channel_message',
    payload: {
      message:
        `Churn risk: ${trend.negativeCount}/${trend.windowSize} recent turns with ` +
        `${input.customerIdentifier || input.conversationId} have trended negative ` +
        `(latest state: ${input.state}). Review the conversation before it escalates further.`,
    },
    orgId: input.orgId,
    timestamp: new Date().toISOString(),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[customer] sentiment trend Slack alert failed: ${message}`);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function logCustomerLedgerActivity(input: {
  orgId: string; employeeRole?: string; employeeId?: string; actionConsidered: string;
  decision: 'executed' | 'escalated' | 'suppressed' | 'declined' | 'deferred';
  reasonCode: string; reasonSummary: string; confidence?: number;
  workItemId?: string; context?: Record<string, unknown>;
}): Promise<void> {
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO agent_decision_ledger (
           org_id, employee_role, action_considered, decision, reason_code, reason_summary,
           confidence_score, context_payload, employee_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [input.orgId, input.employeeRole || 'customer', input.actionConsidered, input.decision,
         input.reasonCode, input.reasonSummary, input.confidence ?? 0, JSON.stringify(input.context || {}),
         input.employeeId && UUID_RE.test(input.employeeId) ? input.employeeId : null],
      );
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
}

export async function attachDecisionCardActivity(input: {
  orgId: string; workItemId: string; customer: string; situation: string;
}): Promise<{ attached: boolean; card: DecisionCard }> {
  const card = lowConfidenceDecisionCard({ customer: input.customer, situation: input.situation });
  const attached = await attachWorkItemCardActivity({
    orgId: input.orgId, workItemId: input.workItemId, card: { ...card, kind: 'customer_decision' },
  });
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `UPDATE work_items SET payload = COALESCE(payload, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ card }), input.workItemId, input.orgId],
      );
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
  return { attached: attached.attached, card };
}

export async function extractObligationActivity(input: {
  orgId: string; conversationId: string; text: string; senderRole?: string;
  customerIdentifier?: string; messageId?: string;
}): Promise<{ opened: number; suppressed: number }> {
  const sender = asSender(input.senderRole);
  const prepared = prepareObligations(input.text, await extractObligations(input.text, sender), sender);
  let opened = 0;
  let suppressed = 0;
  for (const row of prepared) {
    if (row.reasonCode) {
      suppressed += 1;
      await logCustomerLedgerActivity({
        orgId: input.orgId, actionConsidered: 'open_loop', decision: 'suppressed',
        reasonCode: row.reasonCode, reasonSummary: row.promiseSummary, confidence: row.confidence,
        context: { conversationId: input.conversationId },
      });
      continue;
    }
    const hash = contentHashFor(input.orgId, input.conversationId, row.promiseSummary, row.obligor);
    try {
      opened += await withOrgClient(input.orgId, async (client) => {
        const res = await client.query(
          `INSERT INTO agent_open_loops (
             org_id, conversation_id, customer_identifier, obligor, promise_summary,
             source_quote, source_message_id, status, target_check_at, due_basis,
             assigned_employee_role, confidence, content_hash
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9,'customer',$10,$11)
           ON CONFLICT (org_id, content_hash) DO NOTHING RETURNING id`,
          [input.orgId, input.conversationId, input.customerIdentifier || input.conversationId,
           row.obligor, row.promiseSummary, row.quote, input.messageId || null,
           row.dueAtIso, row.dueBasis, row.confidence, hash],
        );
        return res.rowCount ?? 0;
      });
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
    }
  }
  return { opened, suppressed };
}

export async function clusterConversationalInsightsActivity(input: {
  orgId: string; beforeIso: string;
}): Promise<{ topics: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const windowStart = new Date(new Date(input.beforeIso).getTime() - 7 * 86400000).toISOString();
      const res = await client.query<{ topic: string; n: number }>(
        `SELECT lower(substring(regexp_replace(content, '[^a-zA-Z0-9 ]', '', 'g') from 1 for 48)) AS topic,
                COUNT(*)::int AS n
           FROM messages WHERE org_id = $1 AND role = 'user'
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 8`,
        [input.orgId, windowStart, input.beforeIso],
      );
      for (const row of res.rows) {
        if (!row.topic?.trim()) continue;
        await client.query(
          `INSERT INTO conversational_insights (org_id, window_start, window_end, topic, sample_count, recommendation)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.orgId, windowStart, input.beforeIso, row.topic.trim(), row.n,
           row.n >= 8 ? 'Spike — add a FAQ so the employee can answer without escalating.' : 'Recurring question.'],
        );
      }
      return { topics: res.rows.length };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { topics: 0 };
    throw err;
  }
}

/**
 * CE-10 Knowledge Gap Finder — reads the confidence-gate failures already
 * logged to agent_decision_ledger (see runAgentTurn in activities/index.ts)
 * and groups near-duplicate questions so the dashboard can show founders
 * topic clusters instead of a flat log, ranked by recurrence.
 */
export async function listKnowledgeGapClustersActivity(input: {
  orgId: string; sinceIso?: string; limit?: number;
}): Promise<{ clusters: KnowledgeGapCluster[]; totalQuestions: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const since = input.sinceIso || new Date(Date.now() - 30 * 86400000).toISOString();
      const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
      const res = await client.query<{ question: string; created_at: Date | string }>(
        `SELECT context_payload->>'question' AS question, created_at
           FROM agent_decision_ledger
          WHERE org_id = $1
            AND action_considered = 'customer_reply'
            AND decision = 'suppressed'
            AND reason_code = ANY($2::text[])
            AND created_at >= $3::timestamptz
            AND COALESCE(context_payload->>'question', '') <> ''
          ORDER BY created_at DESC
          LIMIT $4`,
        [input.orgId, KNOWLEDGE_GAP_REASON_CODES, since, limit],
      );
      const rows = res.rows.map((row) => ({
        question: row.question,
        createdAt: new Date(row.created_at).toISOString(),
      }));
      return { clusters: clusterGapQuestions(rows), totalQuestions: rows.length };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { clusters: [], totalQuestions: 0 };
    throw err;
  }
}

export async function rollupDecisionLedgerActivity(input: {
  orgId: string; beforeIso: string;
}): Promise<{ rolled: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const cutoff = new Date(new Date(input.beforeIso).getTime() - 90 * 86400000).toISOString();
      const grouped = await client.query<{ day: string; reason_code: string; action_type: string; n: number }>(
        `SELECT created_at::date::text AS day, reason_code, action_considered AS action_type, COUNT(*)::int AS n
           FROM agent_decision_ledger WHERE org_id = $1 AND created_at < $2::timestamptz GROUP BY 1,2,3`,
        [input.orgId, cutoff],
      );
      for (const row of grouped.rows) {
        await client.query(
          `INSERT INTO agent_decision_ledger_daily (org_id, day, reason_code, action_type, decision_count)
           VALUES ($1,$2::date,$3,$4,$5)
           ON CONFLICT (org_id, day, reason_code, action_type)
           DO UPDATE SET decision_count = agent_decision_ledger_daily.decision_count + EXCLUDED.decision_count`,
          [input.orgId, row.day, row.reason_code, row.action_type, row.n],
        );
      }
      const deleted = await client.query(
        `DELETE FROM agent_decision_ledger WHERE org_id = $1 AND created_at < $2::timestamptz`,
        [input.orgId, cutoff],
      );
      return { rolled: deleted.rowCount ?? 0 };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { rolled: 0 };
    throw err;
  }
}
