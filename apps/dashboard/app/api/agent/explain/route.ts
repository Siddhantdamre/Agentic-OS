import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { stripNulChars } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const NO_RECORD = 'I have no record of considering that.';

export async function GET(request: NextRequest) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const q = stripNulChars(searchParams.get('q') || searchParams.get('query') || '').trim();
      const objectId = searchParams.get('objectId') || searchParams.get('action_id') || undefined;
      const actionType = searchParams.get('actionType') || undefined;

      const res = await client.query(
        `SELECT id, action_considered, decision, reason_code, reason_summary,
                confidence_score::text, created_at, employee_role
           FROM agent_decision_ledger
          WHERE org_id = $1
            AND ($2::text IS NULL OR context_payload->>'objectId' = $2 OR entity_id::text = $2 OR id::text = $2)
            AND ($3::text IS NULL OR action_considered = $3)
            AND ($4::text IS NULL OR action_considered ILIKE $4 OR reason_summary ILIKE $4)
          ORDER BY created_at DESC
          LIMIT 25`,
        [orgId, objectId || null, actionType || null, q ? `%${q.replace(/[%_]/g, '')}%` : null],
      ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));

      const rows = res.rows.map((row) => ({
        id: row.id,
        actionConsidered: row.action_considered,
        decision: row.decision,
        reasonCode: row.reason_code,
        reasonSummary: row.reason_summary,
        confidenceScore: parseFloat(String(row.confidence_score || '0')),
        createdAt: row.created_at,
        employeeRole: row.employee_role,
      }));
      const top = rows[0];
      const answer = top
        ? `${top.decision === 'executed' ? 'I' : 'Did not'} ${top.actionConsidered} — ${top.reasonSummary}.`
        : NO_RECORD;

      return NextResponse.json({
        orgId,
        query: q,
        objectId: objectId || null,
        actionType: actionType || null,
        source: rows.length ? 'ledger' : 'none',
        decisions: rows,
        matches: rows,
        answer,
        remedy: top ? 'Open the decision card or send the draft from the brief.' : null,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('explain error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
