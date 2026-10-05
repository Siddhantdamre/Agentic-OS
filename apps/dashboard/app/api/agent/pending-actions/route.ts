import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { decideApproval } from '@/lib/decide-approval';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

/**
 * Resolve a parked autonomy action by token. Timeout never approves — the
 * caller must send an explicit decision. The raw token is hashed; only the
 * hash is stored. Same RBAC, dual approval, audit and execute-on-approve as
 * /api/decisions (shared decideApproval).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = (await jsonBodyOrEmpty(request)) as {
      pendingActionId?: string;
      token?: string;
      decision?: string;
      orgId?: string;
      org_id?: string;
    };
    if (body.orgId || body.org_id) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }
    const pendingActionId = String(body.pendingActionId || '');
    const token = String(body.token || '');
    const decision = String(body.decision || '');
    if (!pendingActionId || !token) {
      return NextResponse.json({ error: 'pendingActionId and token are required' }, { status: 400 });
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    client.release();

    const result = await decideApproval({
      pendingActionId,
      decision,
      actorUserId: userId,
      orgId,
      token,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, pendingActionId }, { status: result.httpStatus });
    }
    return NextResponse.json(
      {
        ok: result.status !== 'execution_failed',
        pendingActionId,
        decision,
        status: result.status,
        decidedBy: userId,
        ...(result.awaitingApprovals !== undefined ? { awaitingApprovals: result.awaitingApprovals } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
      { status: result.status === 'execution_failed' ? 500 : 200 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('API POST /api/agent/pending-actions Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
