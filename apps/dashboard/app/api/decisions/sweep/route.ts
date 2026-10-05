import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';
import { recordAuditEvent } from '@/lib/audit-events';

export const dynamic = 'force-dynamic';

function canSweep(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export async function POST() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canSweep(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      // Same rule as the worker's GovernanceSweepWorkflow: expiry never
      // approves, and decided_by stays NULL because no human decided.
      await client.query('BEGIN');
      let res;
      try {
        res = await client.query(
          `UPDATE agent_pending_actions
              SET status = 'expired', decided_at = NOW(), decided_by = NULL
            WHERE org_id = $1
              AND status = 'pending'
              AND expires_at IS NOT NULL
              AND expires_at <= NOW()
            RETURNING id, work_item_id`,
          [orgId]
        );
        for (const row of res.rows) {
          await recordAuditEvent(
            {
              orgId,
              kind: 'decision.expired',
              actor: { actorType: 'user', userId },
              action: 'decision.expired',
              riskClass: 'medium',
              resultStatus: 'denied',
              workItemId: row.work_item_id ?? null,
              payload: { pendingActionId: row.id, source: 'manual_sweep' },
            },
            { client, orgId }
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      return NextResponse.json({
        orgId,
        expiredCount: res.rowCount || 0,
        expiredIds: res.rows.map((r) => r.id),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/decisions/sweep Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
