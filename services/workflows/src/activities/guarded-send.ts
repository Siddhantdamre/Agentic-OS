import { executeAutonomousToolAction } from '../tool-executor.js';
import {
  checkAutonomy,
  logAutonomyDecision,
  parkPendingAction,
  type BlastRadius,
} from '../autonomy.js';
import {
  isUndefinedTable,
  readIdempotent,
  sideEffectKey,
  withOrgClient,
  writeIdempotent,
} from '../db.js';
import { defaultQuietHours, isQuietHour } from '../quiet-hours.js';
import {
  checkCustomerOutboundAllowed,
  consumeGlobalSendCeiling,
} from '../customer/outbound-budget.js';

export const ROI_METRIC_TYPES = [
  'pipeline_influenced',
  'revenue_recovered',
  'ticket_resolved_autonomously',
  'hours_saved',
  'escalation_avoided',
  'churn_prevented',
] as const;

export type RoiMetricType = (typeof ROI_METRIC_TYPES)[number];

export type GuardedSendResult = {
  sent: boolean;
  reason: string;
  pendingActionId?: string;
};

export interface GuardedSendInput {
  orgId: string;
  employeeRole: string;
  customerKey: string;
  channel: string;
  body: string;
  tool: string;
  action: string;
  confidence: number;
  blastRadius?: BlastRadius;
  workflowId: string;
  businessKey: string;
  payload?: Record<string, unknown>;
  contactId?: string;
  conversationId?: string;
  recordRoi?: RoiMetricType;
}

function outboundDailyCap(): number {
  const raw = Number(process.env.OUTBOUND_DAILY_CAP || 40);
  return Number.isFinite(raw) && raw > 0 ? raw : 40;
}

function zonedHour(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at);
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
  } catch {
    return at.getUTCHours();
  }
}

export async function inQuietHours(orgId: string): Promise<boolean> {
  let timeZone = 'UTC';
  try {
    timeZone = await withOrgClient(orgId, async (client) => {
      const res = await client.query<{ timezone: string | null }>(
        `SELECT COALESCE(
                  (SELECT NULLIF(timezone, '') FROM org_onboarding WHERE org_id = $1),
                  NULLIF(meta->>'timezone', ''),
                  NULLIF(meta->>'time_zone', ''),
                  'UTC'
                ) AS timezone
           FROM orgs WHERE id = $1`,
        [orgId],
      );
      return String(res.rows[0]?.timezone || 'UTC');
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
  const window = defaultQuietHours(timeZone);
  return isQuietHour(zonedHour(new Date(), window.timeZone), window);
}

export async function consumeOutboundBudget(
  orgId: string,
  customerKey: string,
): Promise<{ allowed: boolean; remaining: number; reason?: string }> {
  const gated = await checkCustomerOutboundAllowed(orgId);
  if (!gated.allowed) return { allowed: false, remaining: 0, reason: gated.reason };
  const global = await consumeGlobalSendCeiling();
  if (!global.allowed) return { allowed: false, remaining: 0, reason: global.reason };
  const cap = outboundDailyCap();
  try {
    return await withOrgClient(orgId, async (client) => {
      const today = new Date().toISOString().slice(0, 10);
      const counted = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM agent_decision_ledger
          WHERE org_id = $1
            AND decision = 'executed'
            AND action_considered LIKE '%send%'
            AND created_at >= $2::date
            AND created_at < ($2::date + INTERVAL '1 day')`,
        [orgId, today],
      );
      void customerKey;
      const used = Number(counted.rows[0]?.n ?? 0);
      if (used >= cap) return { allowed: false, remaining: 0 };
      return { allowed: true, remaining: cap - used };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { allowed: true, remaining: cap };
    throw err;
  }
}

export async function recordRoiActivity(input: {
  orgId: string;
  metricType: RoiMetricType;
  amount?: number;
  sourceRef?: string;
}): Promise<void> {
  if (!(ROI_METRIC_TYPES as readonly string[]).includes(input.metricType)) {
    throw new Error(`roi metric_type ${input.metricType} is not in the 024 CHECK`);
  }
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO agent_roi_events (org_id, metric_type, amount, source_ref)
         VALUES ($1, $2, $3, $4)`,
        [input.orgId, input.metricType, input.amount ?? 0, input.sourceRef ?? null],
      );
    });
  } catch (err) {
    if (isUndefinedTable(err)) return;
    throw err;
  }
}

async function sendChannelMessage(input: GuardedSendInput): Promise<{ ok: boolean; message: string }> {
  const channel = input.channel.toLowerCase();
  const tool = channel === 'whatsapp' ? 'whatsapp' : input.tool || 'gmail';
  const action = channel === 'whatsapp' ? 'send_whatsapp_message' : input.action || 'send_email';
  const exec = await executeAutonomousToolAction({
    tool,
    action,
    payload: {
      phone: input.contactId,
      contactId: input.contactId,
      to: input.contactId,
      body: input.body,
      message: input.body,
      ...(input.payload ?? {}),
    },
    orgId: input.orgId,
    toolAllowlist: [tool],
  });
  return { ok: exec.status === 'executed', message: exec.message };
}

export async function guardedSendActivity(input: GuardedSendInput): Promise<GuardedSendResult> {
  const key = sideEffectKey(input.orgId, 'guardedSend', input.businessKey);
  const prior = await readIdempotent<GuardedSendResult>(input.orgId, key);
  if (prior) return prior;

  const done = async (result: GuardedSendResult): Promise<GuardedSendResult> => {
    await writeIdempotent(input.orgId, key, result);
    return result;
  };

  if (await inQuietHours(input.orgId)) {
    return done({ sent: false, reason: 'quiet_hours' });
  }

  const budget = await consumeOutboundBudget(input.orgId, input.customerKey);
  if (!budget.allowed) {
    return done({ sent: false, reason: budget.reason || 'outbound_budget_exhausted' });
  }

  const verdict = await checkAutonomy({
    orgId: input.orgId,
    employeeRole: input.employeeRole,
    tool: input.tool,
    action: input.action,
    confidence: input.confidence,
    blastRadius: input.blastRadius,
  });
  await logAutonomyDecision({
    orgId: input.orgId,
    employeeRole: input.employeeRole,
    tool: input.tool,
    action: input.action,
    verdict,
    confidence: input.confidence,
    payload: { channel: input.channel, customerKey: input.customerKey },
  });

  if (verdict.mode === 'approval_required') {
    const parked = await parkPendingAction({
      orgId: input.orgId,
      workflowId: input.workflowId,
      actionType: verdict.actionType,
      employeeRole: input.employeeRole,
      payload: input.payload ?? { body: input.body, channel: input.channel },
      tool: input.tool,
      action: input.action,
      reasonCode: verdict.reasonCode,
    });
    return done({ sent: false, reason: verdict.reasonCode, pendingActionId: parked.pendingActionId });
  }

  const sent = await sendChannelMessage(input);
  if (!sent.ok) {
    return done({ sent: false, reason: sent.message || 'send_failed' });
  }
  if (input.recordRoi) {
    await recordRoiActivity({
      orgId: input.orgId,
      metricType: input.recordRoi,
      sourceRef: input.businessKey,
    });
  }
  return done({ sent: true, reason: 'sent' });
}
