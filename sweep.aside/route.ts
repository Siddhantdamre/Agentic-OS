import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function canSweep(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Marks pending decisions past expires_at as expired.
 * Expiry never approves. Session org only — parameterized SQL.
 */
export async function POST() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canSweep(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const res = await client.query(
        `UPDATE agent_pending_actions
            SET status = 'expired',
                decided_at = NOW(),
                decided_by = $2
          WHERE org_id = $1
            AND status = 'pending'
            AND expires_at IS NOT NULL
            AND expires_at <= NOW()
          RETURNING id`,
        [orgId, userId]
      );

      return NextResponse.json({
        orgId,
        expiredCount: res.rowCount || 0,
        expiredIds: res.rows.map((r) => r.id),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/decisions/sweep Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
