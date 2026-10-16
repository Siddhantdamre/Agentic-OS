import { getOrgScopedClient } from '@/lib/db';
import { deliverInboundReply, type InboundAgentJob } from '@/lib/inbound-agent';

/**
 * Agent mode: when the AI is not sure it waits for the owner (the confidence
 * gate in WorkItemWorkflow) and the customer hears nothing. If the owner opted
 * in, this tells the customer a teammate will follow up. It watches for the
 * workflow's own "confirm requested: confidence below threshold" event, so it
 * changes nothing in the workflow.
 */

const GATE_EVENT = `
  SELECT 1
    FROM work_events e
    JOIN work_items w ON w.id = e.work_item_id
   WHERE e.org_id = $1
     AND w.org_id = $1
     AND w.conversation_id = $2
     AND e.kind = 'confirm_requested'
     AND e.payload->>'reason' = 'confidence_below_threshold'
     AND e.created_at >= $3
   LIMIT 1`;

async function gateOpened(orgId: string, conversationId: string, since: Date): Promise<boolean> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    const res = await client.query(GATE_EVENT, [orgId, conversationId, since]);
    return (res.rowCount ?? res.rows.length) > 0;
  } finally {
    client.release();
  }
}

export async function watchForHoldingReply(
  job: InboundAgentJob,
  opts: { intervalMs?: number; maxMs?: number } = {}
): Promise<boolean> {
  const cfg = job.autoReply?.holdingReply;
  if (!cfg?.enabled) return false;
  const intervalMs = opts.intervalMs ?? 3000;
  const maxMs = opts.maxMs ?? 90_000;
  const since = new Date(Date.now() - 2000);
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      if (await gateOpened(job.orgId, job.conversationId, since)) {
        await deliverInboundReply(job, cfg.message, {
          executedSteps: [{ step: 1, action: 'Holding reply', result: 'waiting for the owner' }],
          savedByWorkflow: false,
          sendKey: `holding:${job.inboundEventId || job.conversationId}`,
        });
        return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } catch (err: unknown) {
    console.warn('[whatsapp-holding-reply] stopped:', err instanceof Error ? err.message : String(err));
  }
  return false;
}
