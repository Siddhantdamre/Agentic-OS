import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { decideApproval } from '@/lib/decide-approval';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapDecisionRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    actionType: row.action_type,
    employeeRole: row.employee_role,
    payload: row.payload,
    status: row.status,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    executedAt: row.executed_at,
    executionResult: row.execution_result,
    executionError: row.execution_error,
    requiredApprovals: row.required_approvals,
    approvals: row.approvals,
    createdAt: row.created_at,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const history =
        new URL(request.url).searchParams.get('history') === '1' ||
        new URL(request.url).searchParams.get('status') === 'history';

      if (history) {
        const res = await client.query(
          `SELECT id, action_type, employee_role, payload, status, expires_at,
                  decided_at, decided_by, executed_at, execution_result, execution_error,
                  required_approvals, approvals, created_at
             FROM agent_pending_actions
            WHERE org_id = $1 AND status <> 'pending'
            ORDER BY COALESCE(decided_at, created_at) DESC
            LIMIT 100`,
          [orgId]
        );
        return NextResponse.json({ orgId, decisions: res.rows.map((row) => mapDecisionRow(row)) });
      }

      const res = await client.query(
        `SELECT id, action_type, employee_role, payload, status, expires_at,
                decided_at, decided_by, executed_at, execution_result, execution_error,
                required_approvals, approvals, created_at
           FROM agent_pending_actions
          WHERE org_id = $1 AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 50`,
        [orgId]
      );
      return NextResponse.json({ orgId, decisions: res.rows.map((row) => mapDecisionRow(row)) });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/agent_pending_actions|does not exist|relation/i.test(message)) {
      return NextResponse.json({ orgId: null, decisions: [] });
    }
    console.error('GET /api/decisions Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    client.release();

    const body = (await jsonBodyOrEmpty(request)) as {
      id?: string;
      status?: string;
      modifiedPayload?: Record<string, unknown>;
      orgId?: string;
      org_id?: string;
    };
    if (body.orgId || body.org_id) {
      return NextResponse.json(
        { error: 'org_id is not accepted from the client; it is resolved from the session.' },
        { status: 400 }
      );
    }
    if (!body.id || !UUID_RE.test(body.id)) {
      return NextResponse.json({ error: 'Valid id required' }, { status: 400 });
    }
    if (body.status !== 'approved' && body.status !== 'rejected') {
      return NextResponse.json({ error: 'status (approved|rejected) required' }, { status: 400 });
    }

    const result = await decideApproval({
      pendingActionId: body.id,
      decision: body.status,
      actorUserId: userId,
      orgId,
      modifiedPayload: body.modifiedPayload ?? null,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.httpStatus });
    }
    // Any resolved outcome changes the pending list other tabs show.
    realtimeHub.publish(orgId, { type: 'settings_updated', message: `decision:${result.id}` });
    if (result.status === 'execution_failed') {
      return NextResponse.json(
        { success: false, status: 'execution_failed', error: result.error },
        { status: 500 }
      );
    }
    if (result.status === 'pending') {
      return NextResponse.json({
        orgId,
        id: result.id,
        status: 'pending',
        awaitingApprovals: result.awaitingApprovals,
        approvals: result.approvals,
      });
    }
    if (result.status === 'rejected') {
      return NextResponse.json({ orgId, id: result.id, status: 'rejected' });
    }
    return NextResponse.json({
      success: true,
      orgId,
      id: result.id,
      status: 'executed',
      result: result.result,
    });
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/decisions Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
