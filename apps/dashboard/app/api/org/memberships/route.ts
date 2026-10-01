import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** List workspaces the session user belongs to. Org never from body. */
export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      let rows: Array<{
        id: string;
        name: string;
        role: string;
        status: string;
        is_default: boolean;
      }> = [];

      try {
        const res = await client.query(
          `SELECT o.id, o.name, om.role, o.status, om.is_default
           FROM organization_memberships om
           JOIN orgs o ON o.id = om.org_id
           WHERE om.user_id = $1
           ORDER BY om.is_default DESC, o.name ASC`,
          [userId]
        );
        rows = res.rows;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
        const res = await client.query(
          `SELECT o.id, o.name, COALESCE(u.role, 'member') AS role, o.status, true AS is_default
           FROM users u
           JOIN orgs o ON o.id = u.org_id
           WHERE u.id = $1`,
          [userId]
        );
        rows = res.rows;
      }

      return NextResponse.json({
        activeOrgId: orgId,
        memberships: rows.map((r) => ({
          id: r.id,
          name: r.name,
          role: r.role,
          status: r.status,
          isActive: r.id === orgId,
          isDefault: Boolean(r.is_default),
        })),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
