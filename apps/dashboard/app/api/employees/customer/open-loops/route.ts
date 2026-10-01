import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissing(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  return code === '42P01' || /does not exist|relation|column/i.test(err instanceof Error ? err.message : String(err));
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT o.id, o.promise_summary, o.created_at, o.target_check_at AS due_date, o.status,
                o.customer_identifier, o.obligor, o.confidence,
                c.id AS conversation_id, c.channel, c.contact_id
           FROM agent_open_loops o
           LEFT JOIN conversations c ON c.id = o.conversation_id AND c.org_id = o.org_id
          WHERE o.org_id = $1 AND o.status NOT IN ('closed')
          ORDER BY o.target_check_at ASC NULLS LAST, o.created_at DESC
          LIMIT 50`,
        [orgId],
      );
      return NextResponse.json({
        openLoops: res.rows.map((row) => ({
          id: row.id,
          promiseSummary: row.promise_summary,
          createdAt: row.created_at,
          dueDate: row.due_date,
          status: row.status,
          customerIdentifier: row.customer_identifier,
          obligor: row.obligor,
          confidence: row.confidence,
          conversationId: row.conversation_id,
          channel: row.channel,
          contactId: row.contact_id,
        })),
      });
    } catch (err) {
      if (isMissing(err)) return NextResponse.json({ openLoops: [] });
      throw err;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/employees/customer/open-loops Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
      }
      const loopId = typeof body.loopId === 'string' ? body.loopId : '';
      const status = body.status === 'fulfilled' || body.status === 'cancelled' ? body.status : null;
      if (!UUID_RE.test(loopId) || !status) {
        return NextResponse.json({ error: 'loopId and status (fulfilled|cancelled) required' }, { status: 400 });
      }

      const dbStatus = 'closed';
      const notes = status === 'fulfilled' ? 'marked fulfilled by operator' : 'cancelled by operator';
      const res = await client.query(
        `UPDATE agent_open_loops
            SET status = $1,
                closed_at = NOW(),
                resolution_notes = $2,
                updated_at = NOW()
          WHERE id = $3 AND org_id = $4 AND status NOT IN ('closed')
          RETURNING id, status, closed_at`,
        [dbStatus, notes, loopId, orgId],
      );
      if (res.rowCount === 0) {
        return NextResponse.json({ error: 'Open loop not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, loop: res.rows[0], operatorStatus: status });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/employees/customer/open-loops Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
