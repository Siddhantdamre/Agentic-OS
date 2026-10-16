import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { applySessionCookies } from '@/lib/session-cookie';
import { isOnboardingComplete } from '@/lib/auth-user';
import { tryReadJson } from '@/lib/safe-json';
import { recordAuditEvent } from '@/lib/audit-events';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Switch active workspace: verify membership, update users.org_id, rotate
 * session cookies so the next request cannot keep the previous org cookie.
 * Never trusts body org_id as tenancy authority.
 */
export async function POST(request: Request) {
  try {
    const { client, orgId, userId, sessionEpoch } = await getScopedClient();
    try {
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json(
          {
            error:
              'org_id/orgId is not accepted from the client; use targetOrgId and membership is verified server-side.',
          },
          { status: 400 }
        );
      }
      const rawTarget = body.targetOrgId;
      if (typeof rawTarget !== 'string' || !UUID_RE.test(rawTarget)) {
        return NextResponse.json({ error: 'targetOrgId must be a valid UUID' }, { status: 400 });
      }

      // Prefer organization_memberships when present; fall back to users.org_id.
      let membership = await client.query<{
        role: string;
        name: string;
        status: string;
      }>(
        `SELECT om.role, o.name, o.status
         FROM organization_memberships om
         JOIN orgs o ON o.id = om.org_id
         WHERE om.user_id = $1 AND om.org_id = $2
         LIMIT 1`,
        [userId, rawTarget]
      ).catch((err: unknown) => {
        if ((err as { code?: string })?.code === '42P01') {
          return { rows: [] as Array<{ role: string; name: string; status: string }>, rowCount: 0 };
        }
        throw err;
      });

      if (membership.rows.length === 0) {
        membership = await client.query(
          `SELECT COALESCE(u.role, 'member') AS role, o.name, o.status
           FROM users u
           JOIN orgs o ON o.id = u.org_id
           WHERE u.id = $1 AND u.org_id = $2
           LIMIT 1`,
          [userId, rawTarget]
        );
      }

      if (membership.rows.length === 0) {
        return NextResponse.json(
          { error: 'Forbidden: not a member of the requested organization' },
          { status: 403 }
        );
      }

      const org = membership.rows[0];
      if (org.status === 'suspended') {
        return NextResponse.json({ error: 'Workspace is suspended' }, { status: 402 });
      }

      await client.query(
        `UPDATE users
            SET org_id = $1,
                role = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [rawTarget, org.role, userId]
      );
      await client.query("SELECT set_config('app.current_org_id', $1, false)", [rawTarget]);

      try {
        await client.query(
          `UPDATE organization_memberships
           SET is_default = (org_id = $2), updated_at = NOW()
           WHERE user_id = $1`,
          [userId, rawTarget]
        );
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
      }

      const onboardingComplete = await isOnboardingComplete(client, rawTarget);

      try {
        await recordAuditEvent(
          {
            orgId: rawTarget,
            kind: 'org.switch',
            actor: { actorType: 'user', userId },
            action: 'org.switch',
            resultStatus: 'ok',
            payload: { fromOrgId: orgId, toOrgId: rawTarget },
          },
          { client, orgId: rawTarget }
        );
      } catch {
        // best-effort
      }

      const res = NextResponse.json({
        success: true,
        activeOrg: { id: rawTarget, name: org.name, role: org.role },
      });
      await applySessionCookies(res, {
        userId,
        orgId: rawTarget,
        onboardingComplete,
        sessionEpoch,
      });
      return res;
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/org/switch Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
