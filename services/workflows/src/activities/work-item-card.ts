import { isUndefinedTable, withOrgClient } from '../db.js';
export type WorkItemCardPayload = Record<string, unknown>;
export async function attachWorkItemCardActivity(input: {
  orgId: string; workItemId: string; card: WorkItemCardPayload;
}): Promise<{ attached: boolean }> {
  try {
    const n = await withOrgClient(input.orgId, async (client) => {
      const res = await client.query(
        `UPDATE work_items SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
        [JSON.stringify({ card: input.card }), input.workItemId, input.orgId]);
      return res.rowCount ?? 0;
    });
    return { attached: n > 0 };
  } catch (err) {
    if (isUndefinedTable(err)) return { attached: false };
    throw err;
  }
}
export async function appendCardEventActivity(input: {
  orgId: string; workItemId: string;
  kind: 'card_shown' | 'card_approved' | 'card_rejected' | 'card_expired';
  payload: Record<string, unknown>; actor: string; idempotencyKey: string;
}): Promise<{ written: boolean }> {
  try {
    await withOrgClient(input.orgId, async (client) => {
      await client.query(
        `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [input.orgId, input.workItemId, input.kind, JSON.stringify(input.payload), input.actor, input.idempotencyKey]);
    });
    return { written: true };
  } catch (err) {
    if (isUndefinedTable(err)) return { written: false };
    throw err;
  }
}
