import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import { platformErrorResponse, withPlatformTransaction } from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

const LIMIT = 200;

/**
 * GET /api/platform/audit — newest platform actions across all orgs (audited read).
 * admin_audit_log is append-only; this only reads it.
 */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const entries = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'audit.list',
        reason: 'platform audit log',
      },
      async (client) => {
        const res = await client.query(
          `SELECT a.id, a.action, a.platform_role, a.reason, a.created_at,
                  a.target_org_id, o.name AS org_name, u.email AS actor_email
             FROM admin_audit_log a
             LEFT JOIN orgs o ON o.id = a.target_org_id
             LEFT JOIN users u ON u.id = a.actor_user_id
            ORDER BY a.created_at DESC
            LIMIT ${LIMIT}`
        );
        return res.rows.map((row) => ({
          id: row.id as string,
          action: row.action as string,
          actorEmail: row.actor_email as string | null,
          platformRole: row.platform_role as string,
          orgId: row.target_org_id as string | null,
          orgName: row.org_name as string | null,
          reason: row.reason as string,
          createdAt: row.created_at as string | Date,
        }));
      }
    );

    return NextResponse.json({ entries, limit: LIMIT });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/audit', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
