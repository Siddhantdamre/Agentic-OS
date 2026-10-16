import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { isUuid } from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/org/invites/:id — revoke a pending invite.
 * Owner/admin only. The org comes from the session; RLS on org_invites plus
 * the explicit org_id predicate keep this to the caller's own org. Accepted
 * invites are history and are not deletable here.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Invalid invite id' }, { status: 400 });
  }
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const res = await client.query<{ email: string; role: string }>(
        `DELETE FROM org_invites
         WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL
         RETURNING email, role`,
        [id, orgId]
      );
      const revoked = res.rows[0];
      if (!revoked) {
        return NextResponse.json({ error: 'Pending invite not found' }, { status: 404 });
      }
      try {
        await recordAuditEvent(
          {
            orgId,
            kind: 'member.remove',
            actor: { actorType: 'user', userId },
            action: 'invite.revoked',
            resultStatus: 'ok',
            riskClass: 'medium',
            payload: { inviteId: id, email: revoked.email, role: revoked.role },
          },
          { client, orgId }
        );
      } catch (auditErr) {
        console.error('[org/invites] revoke audit failed:', auditErr);
      }
      return NextResponse.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    const scopedAuth = scopedAuthErrorResponse(err);
    if (scopedAuth) return scopedAuth;
    console.error('API /api/org/invites/[id] DELETE Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
