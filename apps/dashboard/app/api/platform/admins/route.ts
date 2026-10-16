import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import { platformErrorResponse, withPlatformTransaction } from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

/** GET /api/platform/admins — who holds a platform role (audited read, read-only). */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const admins = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'admins.list',
        reason: 'platform team',
      },
      async (client) => {
        const res = await client.query(
          `SELECT pa.platform_role, pa.created_at, u.email,
                  (SELECT MAX(created_at) FROM admin_audit_log l WHERE l.actor_user_id = pa.user_id) AS last_active_at
             FROM platform_admins pa
             JOIN users u ON u.id = pa.user_id
            ORDER BY pa.platform_role, u.email`
        );
        return res.rows.map((row) => ({
          email: row.email as string | null,
          role: row.platform_role as string,
          addedAt: row.created_at as string | Date,
          lastActiveAt: row.last_active_at as string | Date | null,
        }));
      }
    );

    return NextResponse.json({ admins });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/admins', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
