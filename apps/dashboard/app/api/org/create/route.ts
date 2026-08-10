import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { pool } from '@/lib/db';

/**
 * POST /api/org/create
 * Called at the final step of onboarding to persist org name, team size,
 * business type, and selected channels (initial channel seed).
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const sessionUserId = cookieStore.get('darex_session')?.value;

  if (!sessionUserId) {
    return NextResponse.json({ status: 'ERROR', message: 'Unauthorized' }, { status: 401 });
  }

  const { businessName, teamSize, businessType, channels } = await request.json().catch(() => ({}));

  if (!businessName) {
    return NextResponse.json({ status: 'ERROR', message: 'Business name is required' }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    // 1. Get or create org for this user
    const userRes = await client.query(
      `SELECT id, email, org_id FROM users WHERE id = $1 LIMIT 1`,
      [sessionUserId]
    );

    if (userRes.rows.length === 0) {
      return NextResponse.json({ status: 'ERROR', message: 'User not found' }, { status: 404 });
    }

    const user = userRes.rows[0];
    let orgId = user.org_id;

    const slug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!orgId) {
      // Create a fresh org for this user
      const orgRes = await client.query(
        `INSERT INTO orgs (name, slug, plan, status)
         VALUES ($1, $2, 'starter', 'active')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [businessName, `${slug}-${Date.now()}`]
      );
      orgId = orgRes.rows[0].id;

      // Link user to org
      await client.query(
        `UPDATE users SET org_id = $1, role = 'owner' WHERE id = $2`,
        [orgId, sessionUserId]
      );
    } else {
      // Update org name/metadata
      await client.query(
        `UPDATE orgs SET name = $1 WHERE id = $2`,
        [businessName, orgId]
      );
    }

    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    // 2. Seed initial channels from selection
    if (Array.isArray(channels) && channels.length > 0) {
      for (const channelType of channels) {
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (org_id, channel_type) DO NOTHING`,
          [orgId, channelType]
        );
      }
    }

    // 3. Set the org cookie
    const res = NextResponse.json({
      status: 'OK',
      orgId,
      businessName,
      teamSize,
      businessType,
      channelsSeeded: channels?.length || 0,
    });

    res.cookies.set('darex_org_id', orgId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });

    return res;
  } catch (err: any) {
    console.error('Org create error:', err);
    return NextResponse.json({ status: 'ERROR', message: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
