import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { rentReminderActivity } from '@darex/workflows/dist/activities/packs';
import { startRentReminderWorkflow } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !UUID_RE.test(text)) return null;
  return text;
}

function missingTables(message: string): boolean {
  return /pm_charges|pm_leases|does not exist|relation/i.test(message);
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, lease_id, kind, amount, currency, status, due_at, claimed_paid_at, psp_payment_id, closed_reason
           FROM pm_charges
          WHERE org_id = $1
          ORDER BY due_at NULLS LAST, updated_at DESC
          LIMIT 100`,
        [orgId]
      );
      return NextResponse.json({
        orgId,
        charges: res.rows.map((row) => ({
          id: row.id,
          leaseId: row.lease_id,
          kind: row.kind,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          dueAt: row.due_at,
          claimedPaidAt: row.claimed_paid_at,
          pspPaymentId: row.psp_payment_id,
          closedReason: row.closed_reason,
        })),
        invented: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ charges: [], invented: false });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    let chargeId = '';

    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }
      if (body.tenantClaimedPaid === true || body.closed === true || body.pspPaymentId) {
        return NextResponse.json(
          {
            error: 'UI rent reminder cannot close a charge or accept a tenant “I paid” claim.',
            closed: false,
          },
          { status: 400 }
        );
      }
      const raw = asUuid(body.chargeId ?? body.id);
      if (!raw) {
        return NextResponse.json({ error: 'chargeId (UUID from this org) is required' }, { status: 400 });
      }
      const found = await client.query(
        `SELECT id, status FROM pm_charges WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [raw, orgId]
      );
      if (!found.rows[0]) {
        return NextResponse.json(
          { error: 'Charge not in this org. Will not invent an amount.', closed: false, invented: false },
          { status: 404 }
        );
      }
      chargeId = raw;
    } finally {
      client.release();
    }

    const businessKey = `rent:${orgId}:${chargeId}:${Date.now()}`;
    const input = { orgId, chargeId, idempotencyKey: businessKey };
    const handle = await startRentReminderWorkflow(input);
    if (handle) {
      const result = await handle.result();
      return NextResponse.json({ ...result, via: 'temporal', invented: false });
    }

    const direct = await rentReminderActivity({
      orgId,
      chargeId,
      businessKey,
    });
    return NextResponse.json({ ...direct, via: 'direct', invented: false });
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json(
        { error: '015_packs.sql not applied', closed: false, invented: false },
        { status: 503 }
      );
    }
    console.error('API POST /api/rent-reminders', err);
    return NextResponse.json({ error: 'Internal Server Error', closed: false }, { status: 500 });
  }
}
