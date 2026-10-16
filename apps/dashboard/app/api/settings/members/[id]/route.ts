import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, isHumanRole, loadHumanRole, parseHumanRole } from '@/lib/rbac';
import { tryReadJson } from '@/lib/safe-json';
import { recordAuditEvent } from '@/lib/audit-events';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, ctx: RouteCtx) {
  try {
    const { id: targetId } = await ctx.params;
    if (!UUID_RE.test(targetId)) {
      return NextResponse.json({ error: 'Invalid member id' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (targetId === userId) {
        return NextResponse.json({ error: 'Cannot remove your own account' }, { status: 400 });
      }

      const target = await client.query<{ role: string }>(
        `SELECT role FROM users WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [targetId, orgId]
      );
      if (target.rows.length === 0) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      if (parseHumanRole(target.rows[0].role) === 'owner') {
        return NextResponse.json({ error: 'Cannot remove organization owner' }, { status: 400 });
      }

      await client.query(`DELETE FROM users WHERE id = $1 AND org_id = $2`, [targetId, orgId]);
      try {
        await client.query(
          `DELETE FROM organization_memberships WHERE user_id = $1 AND org_id = $2`,
          [targetId, orgId]
        );
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
      }

      await recordAuditEvent(
        {
          orgId,
          kind: 'member.remove',
          actor: { actorType: 'user', userId },
          action: 'member.removed',
          resultStatus: 'ok',
          riskClass: 'high',
          payload: { removedUserId: targetId, previousRole: target.rows[0].role },
        },
        { client, orgId }
      );

      return NextResponse.json({ success: true, removedUserId: targetId });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('DELETE /api/settings/members/[id]', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, ctx: RouteCtx) {
  try {
    const { id: targetId } = await ctx.params;
    if (!UUID_RE.test(targetId)) {
      return NextResponse.json({ error: 'Invalid member id' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const actorRole = await loadHumanRole(client, userId);
      if (actorRole !== 'owner') {
        return NextResponse.json(
          { error: 'Forbidden: only owners can change member roles' },
          { status: 403 }
        );
      }

      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const newRoleRaw = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
      if (!isHumanRole(newRoleRaw) || newRoleRaw === 'owner') {
        return NextResponse.json(
          { error: 'role must be admin, member, or auditor' },
          { status: 400 }
        );
      }

      const existing = await client.query<{ role: string; email: string }>(
        `SELECT role, email FROM users WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [targetId, orgId]
      );
      if (existing.rows.length === 0) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      if (parseHumanRole(existing.rows[0].role) === 'owner') {
        return NextResponse.json({ error: 'Cannot modify role of workspace owner' }, { status: 400 });
      }

      const updated = await client.query(
        `UPDATE users SET role = $1, updated_at = NOW()
         WHERE id = $2 AND org_id = $3
         RETURNING id, email, role`,
        [newRoleRaw, targetId, orgId]
      );

      try {
        await client.query(
          `UPDATE organization_memberships SET role = $1, updated_at = NOW()
           WHERE user_id = $2 AND org_id = $3`,
          [newRoleRaw, targetId, orgId]
        );
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
      }

      await recordAuditEvent(
        {
          orgId,
          kind: 'role.change',
          actor: { actorType: 'user', userId },
          action: 'member.role_updated',
          resultStatus: 'ok',
          riskClass: 'medium',
          payload: {
            targetUserId: targetId,
            oldRole: existing.rows[0].role,
            newRole: newRoleRaw,
          },
        },
        { client, orgId }
      );

      return NextResponse.json({ user: updated.rows[0] });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/settings/members/[id]', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
