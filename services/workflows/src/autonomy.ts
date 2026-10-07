/**
 * 4-tier autonomy gate. Escalation score uses reversibility × blast radius ×
 * (1 − confidence). Irreversible always asks — first, unconditionally.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  type ActionBucket,
  type ActionType,
  type Reversibility,
  BUCKET_REVERSIBILITY,
  bucketRuleKey,
  resolveActionType as classifyAction,
} from '@darex/shared-types';
import { withOrgClient } from './db.js';
import { logDecision, type ReasonCode } from './operations/decision-ledger.js';
import { executeProvider } from './tools/index.js';

export { resolveActionType } from '@darex/shared-types';

const DEFAULT_CONFIDENCE = 0.7;

export type AutonomyMode = 'execute' | 'approval_required';
export type AutonomyTier = 1 | 2 | 3 | 4;

export interface BlastRadius {
  amount?: number;
  recordCount?: number;
  externalParties?: number;
  customerTier?: 'routine' | 'key' | 'strategic';
}

export interface AutonomyRule {
  actionType: string;
  autonomyTier: AutonomyTier;
  reversibility: Reversibility;
  requiresHumanApproval: boolean;
  confidenceThreshold: number;
  escalationThreshold: number;
}

export interface AutonomyVerdict {
  mode: AutonomyMode;
  actionType: ActionType;
  bucket: ActionBucket;
  reversibility: Reversibility;
  escalationScore: number;
  reasonCode: ReasonCode;
  ruleSource: 'db_specific' | 'db_bucket' | 'default';
  tier: AutonomyTier;
}

export interface AutonomyRunContext {
  employeeRole?: string;
  workflowId?: string;
  confidence?: number;
  blastRadius?: BlastRadius;
}

export const autonomyRun = new AsyncLocalStorage<AutonomyRunContext>();

/** Contested lease rank: customer > operations > growth (16 §2 / 11 §8). */
export function leasePrecedence(role: string): number {
  switch (role) {
    case 'customer':
      return 3;
    case 'operations':
      return 2;
    case 'growth':
      return 1;
    default:
      return 0;
  }
}

export function canPreemptLease(holderRole: string, challengerRole: string): boolean {
  return leasePrecedence(challengerRole) > leasePrecedence(holderRole);
}

export const DEFAULT_RULES: Record<ActionBucket, AutonomyRule> = {
  read: {
    actionType: 'read_*',
    autonomyTier: 1,
    reversibility: 'reversible',
    requiresHumanApproval: false,
    confidenceThreshold: 0.85,
    escalationThreshold: 0.15,
  },
  draft: {
    actionType: 'draft_email',
    autonomyTier: 2,
    reversibility: 'reversible',
    requiresHumanApproval: true,
    confidenceThreshold: 0.85,
    escalationThreshold: 0.15,
  },
  internal_write: {
    actionType: 'update_field',
    autonomyTier: 3,
    reversibility: 'reversible',
    requiresHumanApproval: false,
    confidenceThreshold: 0.85,
    escalationThreshold: 0.15,
  },
  external_send: {
    actionType: 'send_external_message',
    autonomyTier: 2,
    reversibility: 'visible',
    requiresHumanApproval: true,
    confidenceThreshold: 0.85,
    escalationThreshold: 0.15,
  },
  irreversible: {
    actionType: 'refund_payment',
    autonomyTier: 2,
    reversibility: 'irreversible',
    requiresHumanApproval: true,
    confidenceThreshold: 0.85,
    escalationThreshold: 0.15,
  },
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function normalizeBlastRadius(b?: BlastRadius): number {
  if (!b) return 0.3;
  return Math.max(
    b.amount ? clamp01(b.amount / 50_000) : 0,
    b.recordCount ? clamp01(b.recordCount / 100) : 0,
    b.customerTier === 'strategic' ? 0.9 : b.customerTier === 'key' ? 0.6 : 0,
    b.externalParties ? clamp01(b.externalParties / 10) : 0,
  );
}

function asTier(n: number): AutonomyTier {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

function rowToRule(row: Record<string, unknown>): AutonomyRule {
  return {
    actionType: String(row.action_type),
    autonomyTier: asTier(Number(row.autonomy_tier ?? 2)),
    reversibility: row.reversibility as Reversibility,
    requiresHumanApproval: Boolean(row.requires_human_approval),
    confidenceThreshold: Number(row.confidence_threshold ?? 0.85),
    escalationThreshold: Number(row.escalation_threshold ?? 0.15),
  };
}

async function loadRule(
  orgId: string,
  actionType: string,
  employeeRole: string,
): Promise<AutonomyRule | null> {
  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT action_type, reversibility, requires_human_approval,
                confidence_threshold, escalation_threshold, autonomy_tier
           FROM employee_autonomy_rules
          WHERE org_id = $1
            AND action_type = $2
            AND (employee_role IS NULL OR employee_role = $3)
          ORDER BY employee_role NULLS LAST
          LIMIT 1`,
        [orgId, actionType, employeeRole],
      );
      const row = res.rows[0];
      return row ? rowToRule(row) : null;
    });
  } catch {
    return null;
  }
}

export function evaluateAutonomy(input: {
  actionType: ActionType;
  bucket: ActionBucket;
  rule: AutonomyRule;
  confidence: number;
  blastRadius?: BlastRadius;
  ruleSource: AutonomyVerdict['ruleSource'];
}): AutonomyVerdict {
  const reversibility = input.rule.reversibility ?? BUCKET_REVERSIBILITY[input.bucket];
  const score = normalizeBlastRadius(input.blastRadius) * (1 - input.confidence);
  const base = {
    actionType: input.actionType,
    bucket: input.bucket,
    reversibility,
    escalationScore: score,
    ruleSource: input.ruleSource,
    tier: input.rule.autonomyTier,
  };

  if (reversibility === 'irreversible') {
    return { ...base, mode: 'approval_required', reasonCode: 'irreversible_action' };
  }
  if (input.rule.requiresHumanApproval) {
    return { ...base, mode: 'approval_required', reasonCode: 'org_rule_requires_approval' };
  }
  if (reversibility === 'reversible') {
    return { ...base, mode: 'execute', reasonCode: 'reversible_within_policy' };
  }
  if (input.confidence < (input.rule.confidenceThreshold ?? 0.85)) {
    return { ...base, mode: 'approval_required', reasonCode: 'confidence_below_threshold' };
  }
  if (score > (input.rule.escalationThreshold ?? 0.15)) {
    return { ...base, mode: 'approval_required', reasonCode: 'blast_radius_high' };
  }
  return { ...base, mode: 'execute', reasonCode: 'visible_within_policy' };
}

async function loadConfirmClasses(orgId: string, employeeRole: string): Promise<string[]> {
  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query<{ persona: unknown }>(
        `SELECT persona FROM ai_employees
          WHERE org_id = $1
            AND status = 'active'
            AND (role = $2 OR lower(name) = lower($2))
          ORDER BY CASE WHEN role = $2 THEN 0 ELSE 1 END
          LIMIT 1`,
        [orgId, employeeRole],
      );
      const raw = res.rows[0]?.persona;
      let obj: Record<string, unknown> | null = null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        obj = raw as Record<string, unknown>;
      } else if (typeof raw === 'string' && raw.trim().startsWith('{')) {
        try {
          obj = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          obj = null;
        }
      }
      const classes = obj?.confirmClasses;
      if (!Array.isArray(classes)) return [];
      return classes.map((c) => String(c).toLowerCase()).filter(Boolean);
    });
  } catch {
    return [];
  }
}

function isPayConfirmAction(tool: string, action: string): boolean {
  const a = `${tool}.${action}`.toLowerCase();
  return /(pay|charge|payout|payment|refund)/.test(a);
}

export async function checkAutonomy(input: {
  orgId: string;
  employeeRole: string;
  tool: string;
  action: string;
  confidence?: number;
  blastRadius?: BlastRadius;
}): Promise<AutonomyVerdict> {
  const { actionType, bucket } = classifyAction(input.tool, input.action);
  const confidence = typeof input.confidence === 'number' ? input.confidence : DEFAULT_CONFIDENCE;

  let ruleSource: AutonomyVerdict['ruleSource'] = 'default';
  let rule: AutonomyRule | null = await loadRule(input.orgId, actionType, input.employeeRole);
  if (rule) {
    ruleSource = 'db_specific';
  } else {
    rule = await loadRule(input.orgId, bucketRuleKey(bucket), input.employeeRole);
    if (rule) ruleSource = 'db_bucket';
  }

  const verdict = evaluateAutonomy({
    actionType,
    bucket,
    rule: rule || DEFAULT_RULES[bucket],
    confidence,
    blastRadius: input.blastRadius,
    ruleSource,
  });

  // Persona confirmClasses (e.g. Finance confirmClasses:['pay']) force the
  // existing autonomy gate — never a second gate.
  if (verdict.mode === 'execute' && isPayConfirmAction(input.tool, input.action)) {
    const classes = await loadConfirmClasses(input.orgId, input.employeeRole);
    if (classes.includes('pay')) {
      return {
        ...verdict,
        mode: 'approval_required',
        reasonCode: 'org_rule_requires_approval',
        reversibility: verdict.reversibility === 'reversible' ? 'irreversible' : verdict.reversibility,
      };
    }
  }

  // create_charge / payout always require approval even without confirmClasses.
  if (
    verdict.mode === 'execute' &&
    (actionType === 'create_charge' || actionType === 'create_payment' || /create_charge|payout/.test(`${input.tool}.${input.action}`.toLowerCase()))
  ) {
    return {
      ...verdict,
      mode: 'approval_required',
      reasonCode: 'irreversible_action',
      reversibility: 'irreversible',
    };
  }

  return verdict;
}

export async function seedDefaultAutonomyRules(client: PoolClient, orgId: string): Promise<number> {
  let n = 0;
  for (const [bucket, rule] of Object.entries(DEFAULT_RULES) as Array<[ActionBucket, AutonomyRule]>) {
    await client.query(
      `INSERT INTO employee_autonomy_rules
         (org_id, action_type, employee_role, reversibility, requires_human_approval,
          confidence_threshold, escalation_threshold, autonomy_tier)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        orgId,
        bucketRuleKey(bucket),
        rule.reversibility,
        rule.requiresHumanApproval,
        rule.confidenceThreshold,
        rule.escalationThreshold,
        rule.autonomyTier,
      ]
    );
    n += 1;
  }
  return n;
}

export function buildDecisionCard(input: {
  actionType: string;
  tool: string;
  action: string;
  payload: Record<string, unknown>;
  reasonCode: string;
}): {
  kind: 'decision_card';
  actionType: string;
  options: Array<{ id: string; label: string; cost: string }>;
  recommendation: { optionId: string; basis: string };
} {
  const isRefund = /refund/.test(`${input.actionType} ${input.action} ${input.tool}`);
  const options = isRefund
    ? [
        { id: 'full_refund', label: 'Full refund', cost: 'money leaves the account; irreversible' },
        { id: 'partial_credit', label: 'Partial credit', cost: 'smaller cash hit; still irreversible' },
        { id: 'reject', label: 'Decline refund', cost: 'no payment change; customer stays waiting' },
      ]
    : [
        { id: 'approve', label: 'Approve and run', cost: 'the proposed action executes' },
        { id: 'reject', label: 'Reject', cost: 'no change; logged as declined' },
      ];
  return {
    kind: 'decision_card',
    actionType: input.actionType,
    options,
    recommendation: {
      optionId: isRefund ? 'reject' : 'approve',
      basis: input.reasonCode,
    },
  };
}

/** Human-readable one-liner for PendingDecisionCard / Slack — never invent amounts. */
export function buildActionSummary(
  tool: string,
  action: string,
  payload: Record<string, unknown>
): string {
  const inner =
    payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
      ? (payload.payload as Record<string, unknown>)
      : payload;
  const toolKey = (tool || '').toLowerCase();
  const actionKey = (action || '').toLowerCase();
  if (/refund/.test(`${toolKey} ${actionKey}`)) {
    const amount = inner.amount ?? inner.refundAmount;
    const who = String(inner.customerEmail || inner.customerId || inner.to || 'customer');
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      const dollars = amount > 1000 ? (amount / 100).toFixed(2) : amount.toFixed(2);
      return `Refund $${dollars} to ${who}`;
    }
    return `Refund to ${who}`;
  }
  if (/gmail|email|mail/.test(toolKey) || /send/.test(actionKey)) {
    const subject = String(inner.subject || 'message');
    const to = String(inner.to || inner.recipient || 'recipient');
    return `Send email "${subject}" to ${to}`;
  }
  if (/calendar/.test(toolKey)) {
    const when = String(inner.startTime || inner.start || inner.when || '');
    const summary = String(inner.summary || inner.title || 'event');
    return when ? `Schedule "${summary}" at ${when}` : `Schedule "${summary}"`;
  }
  if (/hubspot/.test(toolKey)) {
    return `HubSpot ${actionKey || 'update'} ${String(inner.dealName || inner.dealId || inner.email || '')}`.trim();
  }
  const label = [tool, action].filter(Boolean).join('.');
  return label ? `Execute ${label}` : 'Proposed action';
}

/**
 * The decision card stored on the inbox work item for a held action. It carries a plain sentence about what the action
 * would do and why it was held, so the inbox, the board and the approvals page can say which action is which.
 */
export function heldActionCard(
  input: { actionType: string; tool?: string; action?: string; payload: Record<string, unknown>; reasonCode?: string },
  card: ReturnType<typeof buildDecisionCard>
) {
  const summary = buildActionSummary(
    input.tool || String(input.payload.tool || ''),
    input.action || String(input.payload.action || ''),
    input.payload
  );
  return {
    kind: 'decision_card' as const,
    actionType: input.actionType,
    title: summary,
    summary,
    reasonCode: input.reasonCode || 'org_rule_requires_approval',
    options: card.options,
    recommendation: card.recommendation,
    payload: input.payload,
  };
}

export async function parkPendingAction(input: {
  orgId: string;
  workflowId: string;
  actionType: string;
  employeeRole: string;
  payload: Record<string, unknown>;
  tool?: string;
  action?: string;
  reasonCode?: string;
  /** Push the card to the managers' Slack channel. Off only when a person is deciding the hold as it is made. */
  announce?: boolean;
}): Promise<{ pendingActionId: string; token: string; workItemId?: string; card?: ReturnType<typeof buildDecisionCard> }> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const card = buildDecisionCard({
    actionType: input.actionType,
    tool: input.tool || '',
    action: input.action || '',
    payload: input.payload,
    reasonCode: input.reasonCode || 'org_rule_requires_approval',
  });
  const saved = await withOrgClient(input.orgId, async (client) => {
    let workItemId: string | undefined;
    try {
      const work = await client.query(
        `INSERT INTO work_items (org_id, type, status, priority, metadata)
         VALUES ($1, 'decision', 'open', 'high', $2::jsonb)
         RETURNING id`,
        [input.orgId, JSON.stringify({ card: heldActionCard(input, card) })]
      );
      workItemId = String(work.rows[0].id);
    } catch {
      workItemId = undefined;
    }
    const res = await client.query(
      `INSERT INTO agent_pending_actions
         (org_id, workflow_id, action_type, employee_role, payload, token_hash, status, work_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [
        input.orgId,
        input.workflowId,
        input.actionType,
        input.employeeRole,
        JSON.stringify({
          ...input.payload,
          card,
          reasonCode: input.reasonCode || 'org_rule_requires_approval',
          summary: buildActionSummary(
            input.tool || String(input.payload.tool || ''),
            input.action || String(input.payload.action || ''),
            input.payload
          ),
        }),
        tokenHash,
        workItemId || null,
      ]
    );
    return { pendingActionId: String(res.rows[0].id), workItemId };
  });
  if (saved.workItemId && input.announce !== false) {
    await notifyManagersOfDecisionCard({
      orgId: input.orgId,
      workItemId: saved.workItemId,
      actionType: input.actionType,
      employeeRole: input.employeeRole,
      reasonCode: input.reasonCode || 'org_rule_requires_approval',
      card,
    });
  }
  return { pendingActionId: saved.pendingActionId, token, workItemId: saved.workItemId, card };
}

/**
 * Announce a hold that was made quietly (a person was deciding it) and then stayed open, because it needs another
 * person or a role the first one lacks. Best-effort, like the original announcement.
 */
export async function announceParkedAction(orgId: string, pendingActionId: string): Promise<void> {
  try {
    const row = await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT action_type, employee_role, payload, work_item_id
           FROM agent_pending_actions
          WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        [pendingActionId, orgId]
      );
      return res.rows[0] as { action_type: string; employee_role: string; payload: Record<string, any> | null; work_item_id: string | null } | undefined;
    });
    if (!row || !row.work_item_id) return;
    const stored = row.payload || {};
    const card = stored.card && typeof stored.card === 'object' && Array.isArray(stored.card.options)
      ? (stored.card as ReturnType<typeof buildDecisionCard>)
      : buildDecisionCard({
          actionType: row.action_type,
          tool: String(stored.tool || ''),
          action: String(stored.action || ''),
          payload: (stored.payload && typeof stored.payload === 'object' ? stored.payload : {}) as Record<string, unknown>,
          reasonCode: 'org_rule_requires_approval',
        });
    await notifyManagersOfDecisionCard({
      orgId,
      workItemId: row.work_item_id,
      actionType: row.action_type,
      employeeRole: row.employee_role,
      reasonCode: 'org_rule_requires_approval',
      card,
    });
  } catch (err) {
    console.warn(`[autonomy] could not announce held action ${pendingActionId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * CE-08: push the decision card to the org's manager Slack channel as soon as
 * it's created, instead of relying on the manager to notice it in the inbox.
 * Best-effort — a Slack failure (not connected, API error) never blocks the
 * approval flow itself, since the work item already exists in the dashboard.
 */
async function notifyManagersOfDecisionCard(input: {
  orgId: string;
  workItemId: string;
  actionType: string;
  employeeRole: string;
  reasonCode: string;
  card: ReturnType<typeof buildDecisionCard>;
}): Promise<void> {
  try {
    const title = `Approval needed: ${input.actionType}`;
    const optionsText = input.card.options.map((o) => `• *${o.label}* — ${o.cost}`).join('\n');
    const message =
      `A *${input.employeeRole}* action needs manager approval (${input.reasonCode}).\n` +
      `${optionsText}\n\nReview in the inbox to decide.`;
    const result = await executeProvider({
      tool: 'slack',
      action: 'post_decision_card',
      actionName: 'post_decision_card',
      payload: { workItemId: input.workItemId, title, message },
      orgId: input.orgId,
      timestamp: new Date().toISOString(),
    });
    if (!result || result.status !== 'executed') {
      const reason = result?.message || 'slack not connected';
      console.warn(`[autonomy] decision card Slack push skipped for work item ${input.workItemId}: ${reason}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autonomy] decision card Slack push failed: ${message}`);
  }
}

export async function logAutonomyDecision(input: {
  orgId: string;
  employeeRole: string;
  employeeId?: string;
  tool: string;
  action: string;
  verdict: AutonomyVerdict;
  confidence: number;
  confidenceBreakdown?: { grounding: number; state: number; precedent: number; self: number };
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await withOrgClient(input.orgId, async (client) => {
      await logDecision(client, {
        orgId: input.orgId,
        employeeRole: input.employeeRole || 'operations',
        employeeId: input.employeeId,
        actionConsidered: `${input.tool}.${input.action}`,
        decision: input.verdict.mode === 'execute' ? 'executed' : 'escalated',
        reasonCode: input.verdict.reasonCode,
        reasonSummary: `${input.verdict.mode} via ${input.verdict.reasonCode} (tier ${input.verdict.tier})`,
        confidence: input.confidence,
        confidenceBreakdown: input.confidenceBreakdown,
        autonomyTier: input.verdict.tier,
        contextPayload: {
          tool: input.tool,
          action: input.action,
          escalationScore: input.verdict.escalationScore,
          reversibility: input.verdict.reversibility,
          payload: input.payload || {},
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[autonomy] ledger write failed: ${message}`);
  }
}
