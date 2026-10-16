import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canApproveActions, canReadOperations, loadHumanRole } from '@/lib/rbac';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { listShadowDecisions, recordShadowReview, shadowCounts } from '@/lib/trust-shadow';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the team would have done in watching mode, waiting for someone to say "yes, same" or "no". */
export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadOperations(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      const [items, counts] = await Promise.all([listShadowDecisions(client, orgId), shadowCounts(client, orgId)]);
      return NextResponse.json({ items, ...counts });
    } finally {
      client.release();
    }
  } catch (err) {
    const auth = scopedAuthErrorResponse(err);
    if (auth) return auth;
    console.error('GET /api/trust/shadow Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** Body: { id, agreed }. One answer per decision; asking again changes the answer. */
export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canApproveActions(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const body = (await jsonBodyOrEmpty(request)) as { id?: unknown; agreed?: unknown; orgId?: string; org_id?: string };
      if (body.orgId || body.org_id) {
        return NextResponse.json({ error: 'org_id is not accepted from the client; it is resolved from the session.' }, { status: 400 });
      }
      if (typeof body.id !== 'string' || !UUID.test(body.id) || typeof body.agreed !== 'boolean') {
        return NextResponse.json({ error: 'Say which decision, and whether you agree with it.' }, { status: 400 });
      }

      const outcome = await recordShadowReview(client, orgId, userId, body.id, body.agreed);
      if (outcome === 'not_found') return NextResponse.json({ error: 'That decision was not found.' }, { status: 404 });
      return NextResponse.json({ ok: true, ...(await shadowCounts(client, orgId)) });
    } finally {
      client.release();
    }
  } catch (err) {
    const auth = scopedAuthErrorResponse(err);
    if (auth) return auth;
    console.error('POST /api/trust/shadow Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
