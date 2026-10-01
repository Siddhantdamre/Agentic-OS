import { canPreemptLease } from '../autonomy.js';
import { isUndefinedTable, withOrgClient } from '../db.js';
import { buildTriageBrief, type TriageBrief } from '../operations/brief.js';
import {
  attachDiscrepancyWorkItem,
  registerExpectationFromRule,
  scanOpenExpectations,
} from '../operations/expected-vs-actual-engine.js';
import { attachWorkItemCardActivity } from './work-item-card.js';
import { guardedSendActivity } from './guarded-send.js';
import { executeProvider } from '../tools/index.js';

export type DueLoop = {
  id: string;
  customer_identifier: string;
  target_check_at: string;
  conversation_id?: string | null;
  channel?: string | null;
  quote?: string | null;
};

export async function dueLoopsActivity(input: { orgId: string; before: string }): Promise<DueLoop[]> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<DueLoop>(
        `SELECT id::text,
                COALESCE(customer_identifier, '') AS customer_identifier,
                target_check_at::text, conversation_id::text,
                NULL::text AS channel, source_quote AS quote
           FROM agent_open_loops
          WHERE org_id = $1 AND status <> 'closed' AND target_check_at <= $2
          ORDER BY target_check_at ASC LIMIT 80`,
        [input.orgId, input.before],
      );
      return res.rows;
    });
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}

export async function acquireLeaseActivity(input: {
  orgId: string; entityKey: string; employeeRole: string; ttlSeconds: number;
}): Promise<{ acquired: boolean; holder?: string }> {
  const ttl = Math.max(30, input.ttlSeconds || 300);
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const existing = await client.query<{ employee_role: string; expires_at: Date }>(
        `SELECT employee_role, expires_at FROM agent_entity_leases WHERE org_id = $1 AND entity_key = $2`,
        [input.orgId, input.entityKey],
      );
      const row = existing.rows[0];
      const expired = row ? new Date(row.expires_at).getTime() <= Date.now() : true;
      if (row && !expired && !canPreemptLease(row.employee_role, input.employeeRole)) {
        return { acquired: false, holder: row.employee_role };
      }
      await client.query(
        `INSERT INTO agent_entity_leases (org_id, entity_key, employee_role, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval)
         ON CONFLICT (org_id, entity_key)
         DO UPDATE SET employee_role = EXCLUDED.employee_role, expires_at = EXCLUDED.expires_at`,
        [input.orgId, input.entityKey, input.employeeRole, String(ttl)],
      );
      return { acquired: true };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { acquired: true };
    throw err;
  }
}

export async function releaseLeaseActivity(input: { orgId: string; entityKey: string }): Promise<void> {
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(`DELETE FROM agent_entity_leases WHERE org_id = $1 AND entity_key = $2`, [
        input.orgId,
        input.entityKey,
      ]);
    });
  } catch (err) {
    if (isUndefinedTable(err)) return;
    throw err;
  }
}

export async function handleDueLoopActivity(input: {
  orgId: string; loopId: string; businessKey: string; workflowId?: string;
}): Promise<{ handled: boolean; reason: string }> {
  let loop: {
    id: string; customer_identifier: string; conversation_id: string | null;
    channel: string | null; quote: string | null; status: string;
  } | null = null;
  try {
    loop = await withOrgClient(input.orgId, async (client) => {
      const res = await client.query(
        `SELECT id::text, COALESCE(customer_identifier, '') AS customer_identifier,
                conversation_id::text, NULL::text AS channel, source_quote AS quote, status
           FROM agent_open_loops WHERE org_id = $1 AND id = $2`,
        [input.orgId, input.loopId],
      );
      return res.rows[0] ?? null;
    });
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
  if (!loop || loop.status === 'closed') return { handled: false, reason: 'missing_or_closed' };
  const body = loop.quote?.trim()
    ? `Checking in on: ${loop.quote.trim().slice(0, 240)}`
    : 'Checking in on the open item we owe you — reply anytime.';
  const send = await guardedSendActivity({
    orgId: input.orgId,
    employeeRole: 'customer',
    customerKey: loop.customer_identifier || loop.id,
    channel: loop.channel || 'email',
    body,
    tool: loop.channel === 'whatsapp' ? 'whatsapp' : 'gmail',
    action: loop.channel === 'whatsapp' ? 'send_whatsapp_message' : 'send_email',
    confidence: 0.7,
    workflowId: input.workflowId || `open-loops:${input.orgId}`,
    businessKey: input.businessKey,
    contactId: loop.customer_identifier,
    conversationId: loop.conversation_id ?? undefined,
  });
  if (send.sent) {
    try {
      await withOrgClient(input.orgId, async (client) => {
        await client.query(
          `UPDATE agent_open_loops SET target_check_at = NOW() + INTERVAL '48 hours', updated_at = NOW()
            WHERE id = $1 AND org_id = $2`,
          [input.loopId, input.orgId],
        );
      });
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
    }
  }
  return { handled: send.sent, reason: send.reason };
}

export async function runMorningCheckActivity(input: {
  orgId: string; before: string;
}): Promise<{ processed: number; brief: TriageBrief }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<{ id: string; conversation_id: string | null }>(
        `SELECT id::text, conversation_id::text FROM operational_enquiries
          WHERE org_id = $1 AND state NOT IN ('closed', 'cancelled')
            AND sla_expires_at IS NOT NULL AND sla_expires_at <= $2
          ORDER BY sla_expires_at ASC LIMIT 50`,
        [input.orgId, input.before],
      );
      const discrepancies = await scanOpenExpectations(client, input.orgId);
      const brief = buildTriageBrief([
        ...res.rows.map((row) => ({
          severity: 'high' as const,
          title: 'SLA overdue',
          detail: row.id,
          objectId: row.id,
        })),
        ...discrepancies.map((item) => ({
          severity: 'critical' as const,
          title: 'Expectation missed',
          detail: item.comparison.magnitude,
          objectId: item.objectId,
        })),
      ]);
      if (res.rows.length === 0) return { processed: 0, brief };
      for (const row of res.rows) {
        if (row.conversation_id) {
          await attachWorkItemCardActivity({
            orgId: input.orgId,
            workItemId: row.conversation_id,
            card: { kind: 'morning_check', enquiryId: row.id, dueAt: input.before, brief },
          }).catch(() => undefined);
        }
        await client.query(
          `UPDATE operational_enquiries SET state = 'needs_attention', updated_at = NOW()
            WHERE id = $1 AND org_id = $2 AND state NOT IN ('closed', 'cancelled')`,
          [row.id, input.orgId],
        );
      }
      return { processed: res.rows.length, brief };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { processed: 0, brief: buildTriageBrief([]) };
    throw err;
  }
}

/**
 * OE-02: deliver the executive standup brief to Slack and WhatsApp once
 * morning triage completes. Best-effort on both channels — a missing
 * connection or provider error is logged and skipped, it never fails the
 * workflow, since the brief always remains visible in the dashboard.
 */
export async function deliverBriefActivity(input: {
  orgId: string;
  brief: TriageBrief;
}): Promise<{ slackDelivered: boolean; whatsappDelivered: boolean }> {
  const lines = [input.brief.headline, ...input.brief.exceptions.map((e) => `• [${e.severity}] ${e.title}: ${e.detail}`)];
  if (input.brief.counts.dropped > 0) {
    lines.push(`+${input.brief.counts.dropped} more not shown.`);
  }
  const message = lines.join('\n');

  let slackDelivered = false;
  try {
    const result = await executeProvider({
      tool: 'slack',
      action: 'send_channel_message',
      actionName: 'send_channel_message',
      payload: { message },
      orgId: input.orgId,
      timestamp: new Date().toISOString(),
    });
    slackDelivered = result?.status === 'executed';
    if (!slackDelivered) {
      console.warn(`[brief] Slack delivery skipped for org ${input.orgId}: ${result?.message || 'slack not connected'}`);
    }
  } catch (err) {
    console.warn(`[brief] Slack delivery failed for org ${input.orgId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let whatsappDelivered = false;
  try {
    const phone = await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<{ phone: string | null }>(
        `SELECT COALESCE(NULLIF(meta->>'ops_whatsapp_number', ''), NULLIF(meta->>'owner_phone', '')) AS phone
           FROM orgs WHERE id = $1`,
        [input.orgId],
      );
      return res.rows[0]?.phone || null;
    });
    if (!phone) {
      console.warn(`[brief] WhatsApp delivery skipped for org ${input.orgId}: no ops_whatsapp_number configured`);
    } else {
      const result = await executeProvider({
        tool: 'whatsapp',
        action: 'send_whatsapp_message',
        actionName: 'send_whatsapp_message',
        payload: { phone, message },
        orgId: input.orgId,
        timestamp: new Date().toISOString(),
      });
      whatsappDelivered = result?.status === 'executed';
      if (!whatsappDelivered) {
        console.warn(`[brief] WhatsApp delivery skipped for org ${input.orgId}: ${result?.message || 'whatsapp not connected'}`);
      }
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn(`[brief] WhatsApp delivery failed for org ${input.orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { slackDelivered, whatsappDelivered };
}

/**
 * OE-03: register a declarative operational expectation (see
 * OPERATIONAL_EXPECTATION_RULES) for an object as soon as the triggering
 * event happens, e.g. a hot lead being assigned or a contact being created.
 * A no-op no-throw when the named rule does not exist or the table is
 * missing, so callers do not need to special-case rollout state.
 */
export async function registerExpectationActivity(input: {
  orgId: string;
  ruleName: string;
  objectId: string;
  triggeredAt: string;
  actualState?: string;
}): Promise<{ registered: boolean }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const result = await registerExpectationFromRule(client, {
        orgId: input.orgId,
        ruleName: input.ruleName,
        objectId: input.objectId,
        triggeredAt: new Date(input.triggeredAt),
        actualState: input.actualState,
      });
      return { registered: Boolean(result) };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { registered: false };
    throw err;
  }
}

export async function runStuckWorkActivity(input: {
  orgId: string; before: string;
}): Promise<{ processed: number }> {
  void input.before;
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const scanned = await scanOpenExpectations(client, input.orgId);
      if (scanned.length > 0) {
        for (const item of scanned) {
          await attachDiscrepancyWorkItem(client, input.orgId, item);
        }
        return { processed: scanned.length };
      }
      const res = await client.query<{ id: string }>(
        `SELECT id::text FROM operational_expectations
          WHERE org_id = $1 AND settled_at IS NULL AND is_discrepancy = TRUE
          ORDER BY created_at ASC LIMIT 50`,
        [input.orgId],
      );
      if (res.rows.length === 0) return { processed: 0 };
      for (const row of res.rows) {
        await client.query(
          `INSERT INTO work_items (org_id, type, status, metadata)
           VALUES ($1, 'stuck_work', 'needs_attention', $2::jsonb)`,
          [input.orgId, JSON.stringify({ card: { kind: 'stuck_work', expectationId: row.id } })],
        );
      }
      return { processed: res.rows.length };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { processed: 0 };
    throw err;
  }
}

export async function checkCustomerHealthActivity(input: {
  orgId: string; sinceIso: string; customerIdentifier: string;
}): Promise<{ atRisk: boolean; reason: string }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM conversations
          WHERE org_id = $1 AND (contact_id = $2 OR metadata->>'customer_identifier' = $2)
            AND status IN ('needs_attention', 'open') AND updated_at >= $3::timestamptz`,
        [input.orgId, input.customerIdentifier, input.sinceIso],
      );
      const n = Number(res.rows[0]?.n ?? 0);
      return { atRisk: n > 0, reason: n > 0 ? 'open_attention' : 'healthy' };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { atRisk: false, reason: 'unavailable' };
    throw err;
  }
}

export async function sendCheckInActivity(input: {
  orgId: string; customerIdentifier: string; conversationId?: string;
  body?: string; workflowId: string; businessKey: string;
}): Promise<{ sent: boolean; reason: string }> {
  const send = await guardedSendActivity({
    orgId: input.orgId,
    employeeRole: 'customer',
    customerKey: input.customerIdentifier,
    channel: 'email',
    body: input.body || 'Wanted to check in — is there anything still open on our side?',
    tool: 'gmail',
    action: 'send_email',
    confidence: 0.65,
    workflowId: input.workflowId,
    businessKey: input.businessKey,
    contactId: input.customerIdentifier,
    conversationId: input.conversationId,
    recordRoi: 'churn_prevented',
  });
  return { sent: send.sent, reason: send.reason };
}
