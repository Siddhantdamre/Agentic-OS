import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function missingTables(message: string): boolean {
  return /pm_charges|pm_leases|does not exist|relation/i.test(message);
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      const leaseId = typeof body.leaseId === 'string' ? body.leaseId.trim() : '';
      if (!leaseId || !UUID_RE.test(leaseId)) {
        return NextResponse.json({ error: 'leaseId (UUID) is required' }, { status: 400 });
      }

      const amountRaw = body.amount;
      const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw);
      if (!Number.isFinite(amount) || amount < 0) {
        return NextResponse.json(
          { error: 'amount is required and must be a non-negative number (from source of record)' },
          { status: 400 }
        );
      }

      const lease = await client.query(
        `SELECT id FROM pm_leases WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [leaseId, orgId]
      );
      if (!lease.rows[0]) {
        return NextResponse.json({ error: 'Lease not in this org', invented: false }, { status: 404 });
      }

      const currency = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim() : 'INR';
      const dueAt = typeof body.dueAt === 'string' && body.dueAt.trim() ? body.dueAt.trim() : null;
      const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'rent';

      const res = await client.query(
        `INSERT INTO pm_charges (org_id, lease_id, kind, amount, currency, status, due_at, payload)
         VALUES ($1, $2, $3, $4, $5, 'open', $6::timestamptz, $7::jsonb)
         RETURNING id, lease_id, kind, amount, currency, status, due_at, created_at`,
        [
          orgId,
          leaseId,
          kind,
          amount,
          currency,
          dueAt,
          JSON.stringify({
            payment_url: typeof body.paymentUrl === 'string' ? body.paymentUrl : null,
            note: typeof body.note === 'string' ? body.note : null,
          }),
        ]
      );

      return NextResponse.json({ charge: res.rows[0], invented: false }, { status: 201 });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ error: '015_packs.sql not applied', invented: false }, { status: 503 });
    }
    console.error('POST /api/rent-reminders/charges', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
