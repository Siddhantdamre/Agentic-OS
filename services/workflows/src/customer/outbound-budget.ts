import { isUndefinedTable, withOrgClient, workerPool } from '../db.js';

export function globalSendsPerMinuteCap(): number {
  const raw = Number(process.env.DAREX_GLOBAL_SENDS_PER_MINUTE || 30);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

export async function checkCustomerOutboundAllowed(orgId: string) {
  try {
    return await withOrgClient(orgId, async (client) => {
      const controls = await client.query<{
        kill_switch: boolean; autonomy_stage: number; outbound_daily_cap: number | null;
      }>(`SELECT kill_switch, autonomy_stage, outbound_daily_cap FROM org_runtime_controls WHERE org_id = $1`, [orgId]);
      const row = controls.rows[0];
      if (row?.kill_switch) return { allowed: false, reason: 'kill_switch', remaining: 0 };
      if (Number(row?.autonomy_stage ?? 0) <= 1) return { allowed: false, reason: 'autonomy_stage_internal', remaining: 0 };
      const cap = Number(row?.outbound_daily_cap) > 0 ? Number(row.outbound_daily_cap) : 40;
      const today = new Date().toISOString().slice(0, 10);
      const counted = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM agent_decision_ledger
          WHERE org_id = $1 AND decision = 'executed' AND action_considered LIKE '%send%'
            AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day')`,
        [orgId, today],
      );
      const used = Number(counted.rows[0]?.n ?? 0);
      if (used >= cap) return { allowed: false, reason: 'outbound_budget_exhausted', remaining: 0 };
      return { allowed: true, reason: 'ok', remaining: cap - used };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { allowed: true, reason: 'ok', remaining: 40 };
    throw err;
  }
}

export async function consumeGlobalSendCeiling() {
  const cap = globalSendsPerMinuteCap();
  const client = await workerPool.connect();
  try {
    // SECURITY DEFINER (migration 201): tenants cannot touch the table directly.
    const res = await client.query<{ send_count: number }>(
      `SELECT platform_send_counter_bump() AS send_count`,
    );
    const used = Number(res.rows[0]?.send_count ?? 0);
    if (used > cap) return { allowed: false, reason: 'global_send_ceiling', remaining: 0 };
    return { allowed: true, reason: 'ok', remaining: Math.max(0, cap - used) };
  } catch (err) {
    if (isUndefinedTable(err)) return { allowed: true, reason: 'ok', remaining: cap };
    throw err;
  } finally {
    client.release();
  }
}

export async function consumeOutboundBudget(orgId: string, customerIdentifier?: string) {
  void customerIdentifier;
  return checkCustomerOutboundAllowed(orgId);
}
