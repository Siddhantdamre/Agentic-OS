import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { canApproveActions, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['open', 'paid', 'disputed']);

/** Marks one due paid, disputed, or open again: { status, paymentRef?, note? }. Only the owner side closes a due. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'That item could not be found.' }, { status: 404 });
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });
      const role = await loadHumanRole(client, userId);
      if (!canApproveActions(role)) {
        return NextResponse.json({ error: 'Only an owner, admin or manager can change what is owed to you.' }, { status: 403 });
      }
      const status = typeof body.status === 'string' ? body.status : '';
      if (!STATUSES.has(status)) return NextResponse.json({ error: 'Choose paid, disputed or open.' }, { status: 400 });
      const paymentRef = typeof body.paymentRef === 'string' && body.paymentRef.trim() ? body.paymentRef.trim().slice(0, 120) : null;
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
      const res = await client.query(
        `UPDATE org_dues
            SET status = $3,
                paid_at = CASE WHEN $3 = 'paid' THEN NOW() ELSE NULL END,
                payment_ref = CASE WHEN $3 = 'paid' THEN $4 ELSE NULL END,
                note = COALESCE($5, note),
                updated_at = NOW()
          WHERE id = $1 AND org_id = $2
          RETURNING id, status`,
        [id, orgId, status, paymentRef, note],
      );
      if (!res.rows[0]) return NextResponse.json({ error: 'That item could not be found.' }, { status: 404 });
      return NextResponse.json({ id: res.rows[0].id, status: res.rows[0].status });
    } finally {
      client.release();
    }
  } catch (err) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('PATCH /api/dues/[id] Error:', err);
    return NextResponse.json({ error: 'Could not update that. Please try again.' }, { status: 500 });
  }
}
