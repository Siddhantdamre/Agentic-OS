/**
 * Counterfactual decision log. Every gate evaluation writes a row whether or
 * not it acted — "why didn't you?" cannot be reconstructed later.
 */
import type { PoolClient } from 'pg';
import type { DecisionOutcome, EmployeeRole } from '@darex/shared-types';

export type ReasonCode =
  | 'already_resolved'
  | 'reversible_within_policy'
  | 'visible_within_policy'
  | 'irreversible_action'
  | 'org_rule_requires_approval'
  | 'confidence_below_threshold'
  | 'blast_radius_high'
  | 'verification_failed'
  | 'budget_exhausted'
  | 'lease_contested'
  | 'outbound_budget_exhausted'
  | 'missing_connector_scope'
  | 'role_disallowed_tool'
  | 'role_capability_denied'
  | 'ambiguous_duplicate'
  | 'poison_trigger'
  | 'partial_failure_frozen'
  | 'approval_expired'
  | 'executed'
  | 'suppressed_preference';

export interface ConfidenceBreakdown {
  grounding: number;
  state: number;
  precedent: number;
  self: number;
}

export interface LogDecisionInput {
  orgId: string;
  employeeRole: EmployeeRole | string;
  /** Acting ai_employees.id; omit (null) for role-level work with no single owner. */
  employeeId?: string | null;
  actionConsidered: string;
  decision: DecisionOutcome;
  reasonCode: ReasonCode | string;
  reasonSummary: string;
  confidence: number;
  confidenceBreakdown?: ConfidenceBreakdown | null;
  entityId?: string | null;
  workItemId?: string | null;
  autonomyTier?: number | null;
  contextPayload?: Record<string, unknown> | null;
}

export interface DecisionLedgerRow {
  id: string;
  orgId: string;
  employeeRole: string;
  actionConsidered: string;
  decision: DecisionOutcome;
  reasonCode: string;
  reasonSummary: string;
  confidenceScore: number;
  confidenceBreakdown: ConfidenceBreakdown | null;
  entityId: string | null;
  createdAt: string;
}

function rowToLedger(row: Record<string, unknown>): DecisionLedgerRow {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    employeeRole: String(row.employee_role),
    actionConsidered: String(row.action_considered),
    decision: row.decision as DecisionOutcome,
    reasonCode: String(row.reason_code),
    reasonSummary: String(row.reason_summary),
    confidenceScore: Number(row.confidence_score),
    confidenceBreakdown: (row.confidence_breakdown as ConfidenceBreakdown) || null,
    entityId: row.entity_id ? String(row.entity_id) : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function logDecision(client: PoolClient, input: LogDecisionInput): Promise<DecisionLedgerRow> {
  const score = Math.max(0, Math.min(1, input.confidence));
  const res = await client.query(
    `INSERT INTO agent_decision_ledger (
       org_id, employee_role, action_considered, decision, reason_code, reason_summary,
       confidence_score, confidence_breakdown, entity_id, work_item_id, autonomy_tier, context_payload, employee_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.orgId,
      input.employeeRole,
      input.actionConsidered,
      input.decision,
      input.reasonCode,
      input.reasonSummary,
      Number(score.toFixed(3)),
      input.confidenceBreakdown ? JSON.stringify(input.confidenceBreakdown) : null,
      input.entityId || null,
      input.workItemId || null,
      input.autonomyTier ?? null,
      input.contextPayload ? JSON.stringify(input.contextPayload) : null,
      input.employeeId && UUID_RE.test(input.employeeId) ? input.employeeId : null,
    ]
  );
  return rowToLedger(res.rows[0]);
}

export interface ExplainFilter {
  actionId?: string;
  entityId?: string;
  objectId?: string;
  actionType?: string;
  sinceHours?: number;
  q?: string;
}

/**
 * Facts only — never invent a reason. The model may phrase these rows; it
 * must not supply them.
 */
export async function explain(
  client: PoolClient,
  orgId: string,
  filter: ExplainFilter
): Promise<{ rows: DecisionLedgerRow[]; source: 'ledger' }> {
  if (filter.actionId) {
    const res = await client.query(
      `SELECT * FROM agent_decision_ledger WHERE org_id = $1 AND id = $2`,
      [orgId, filter.actionId]
    );
    return { rows: res.rows.map((row) => rowToLedger(row)), source: 'ledger' };
  }

  const clauses = ['org_id = $1'];
  const params: unknown[] = [orgId];
  if (filter.entityId) {
    params.push(filter.entityId);
    clauses.push(`entity_id = $${params.length}`);
  }
  if (filter.actionType) {
    params.push(filter.actionType);
    clauses.push(`action_considered = $${params.length}`);
  }
  if (filter.objectId) {
    params.push(filter.objectId);
    clauses.push(`(context_payload->>'objectId' = $${params.length} OR entity_id::text = $${params.length})`);
  }
  if (filter.q) {
    params.push(`%${filter.q.replace(/[%_]/g, '')}%`);
    clauses.push(
      `(action_considered ILIKE $${params.length} OR reason_summary ILIKE $${params.length} OR reason_code ILIKE $${params.length} OR COALESCE(context_payload::text, '') ILIKE $${params.length})`
    );
  }
  const hours = typeof filter.sinceHours === 'number' && filter.sinceHours > 0 ? filter.sinceHours : 90 * 24;
  params.push(hours);
  clauses.push(`created_at >= NOW() - ($${params.length}::text || ' hours')::interval`);

  const res = await client.query(
    `SELECT * FROM agent_decision_ledger
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 25`,
    params
  );
  return { rows: res.rows.map((row) => rowToLedger(row)), source: 'ledger' };
}

const NO_RECORD = 'I have no record of considering that.';

export interface ExplainAnswer {
  answer: string;
  source: 'ledger' | 'none';
  reasonCode?: string;
  grounding?: number;
  remedy?: string;
  rows: DecisionLedgerRow[];
}

function remedyFor(reasonCode: string): string {
  switch (reasonCode) {
    case 'confidence_below_threshold':
      return 'Raise grounding (cite a source) or confirm the fact, then ask again.';
    case 'irreversible_action':
      return 'Approve the decision card explicitly — irreversible work never auto-runs.';
    case 'org_rule_requires_approval':
      return 'Change the org autonomy rule, or approve this instance.';
    case 'blast_radius_high':
      return 'Narrow the blast radius (fewer records / lower amount) or approve.';
    case 'lease_contested':
      return 'Wait for the other employee to finish, or take the lease.';
    default:
      return 'Open the decision card or adjust the matching autonomy rule.';
  }
}

/**
 * Phrase a ledger-sourced answer. Never invents a reason when the ledger is empty.
 */
export function formatExplainAnswer(
  question: string,
  rows: DecisionLedgerRow[]
): ExplainAnswer {
  void question;
  if (!rows.length) {
    return { answer: NO_RECORD, source: 'none', rows: [] };
  }
  const row = rows[0];
  const grounding =
    row.confidenceBreakdown && typeof row.confidenceBreakdown.grounding === 'number'
      ? row.confidenceBreakdown.grounding
      : undefined;
  const groundingBit =
    typeof grounding === 'number' ? ` Grounding term ${grounding.toFixed(2)}.` : '';
  const remedy = remedyFor(row.reasonCode);
  const answer =
    `Did not ${row.actionConsidered} — ${row.reasonSummary} ` +
    `(reason_code=${row.reasonCode}, confidence ${row.confidenceScore.toFixed(2)}).` +
    groundingBit +
    ` Remedy: ${remedy}`;
  return {
    answer,
    source: 'ledger',
    reasonCode: row.reasonCode,
    grounding,
    remedy,
    rows,
  };
}
