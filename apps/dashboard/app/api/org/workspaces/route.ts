import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse, createWorkspaceOrg } from '@/lib/db';
import { attachUserToOrg } from '@/lib/auth-user';
import { applySessionCookies } from '@/lib/session-cookie';
import { tryReadJson } from '@/lib/safe-json';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  parseWorkspaceName,
  WORKSPACES_PER_USER_MAX,
  WORKSPACE_NAME_MAX,
} from '@/lib/workspace-name';

export const dynamic = 'force-dynamic';

/**
 * POST /api/org/workspaces — create an additional workspace for the session
 * user, make them its owner, switch the session to it (onboarding not done).
 * Body: { name }. Org ids are never accepted from the client.
 */
export async function POST(request: Request) {
  try {
    const { client, orgId: fromOrgId, userId, sessionEpoch } = await getScopedClient();
    try {
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; the new workspace id is generated server-side.' },
          { status: 400 }
        );
      }
      const name = parseWorkspaceName(body.name);
      if (!name) {
        return NextResponse.json(
          { error: `Workspace name is required (max ${WORKSPACE_NAME_MAX} characters).` },
          { status: 400 }
        );
      }

      const count = await client
        .query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM organization_memberships WHERE user_id = $1`, [userId])
        .then((r) => Number(r.rows[0]?.n ?? 0))
        .catch((err: unknown) => {
          if ((err as { code?: string })?.code === '42P01') return 0;
          throw err;
        });
      if (count >= WORKSPACES_PER_USER_MAX) {
        return NextResponse.json(
          { error: `You can belong to at most ${WORKSPACES_PER_USER_MAX} workspaces.` },
          { status: 409 }
        );
      }

      const newOrgId = await createWorkspaceOrg(client, name);
      await attachUserToOrg(client, userId, newOrgId, 'owner');
      await client.query(
        `UPDATE organization_memberships SET is_default = (org_id = $2), updated_at = NOW() WHERE user_id = $1`,
        [userId, newOrgId]
      );

      try {
        await recordAuditEvent(
          {
            orgId: newOrgId,
            kind: 'org.switch',
            actor: { actorType: 'user', userId },
            action: 'org.create',
            resultStatus: 'ok',
            payload: { fromOrgId, toOrgId: newOrgId },
          },
          { client, orgId: newOrgId }
        );
      } catch (err: unknown) {
        console.warn('[org/workspaces] audit_events insert failed:', err instanceof Error ? err.message : String(err));
      }

      const res = NextResponse.json(
        { success: true, activeOrg: { id: newOrgId, name, role: 'owner' }, next: '/onboarding/name' },
        { status: 201 }
      );
      await applySessionCookies(res, { userId, orgId: newOrgId, onboardingComplete: false, sessionEpoch });
      return res;
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/org/workspaces Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
