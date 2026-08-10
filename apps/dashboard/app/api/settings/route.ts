import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const orgRes = await client.query(
        'SELECT id, name, slug, plan, status, created_at FROM orgs WHERE id = $1',
        [orgId]
      );
      const org = orgRes.rows[0] || { name: 'My Business', plan: 'pro', status: 'active' };

      const membersRes = await client.query(
        'SELECT id, email, role, created_at FROM users WHERE org_id = $1 ORDER BY created_at ASC',
        [orgId]
      );

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const webhookDetails = {
        chatwootWebhookUrl: `${appUrl}/api/webhooks/chatwoot`,
        metaWebhookUrl: `${appUrl}/api/webhooks/chatwoot`,
        verifyToken: process.env.VERIFY_TOKEN || null,
      };

      return NextResponse.json({
        org,
        members: membersRes.rows,
        webhookDetails,
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/settings GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { action, orgName, inviteEmail, inviteRole } = body;

      if (action === 'update_org' && orgName) {
        await client.query('UPDATE orgs SET name = $1, updated_at = NOW() WHERE id = $2', [orgName, orgId]);
        return NextResponse.json({ success: true, message: 'Organization updated' });
      }

      if (action === 'invite_member' && inviteEmail) {
        const role = inviteRole || 'member';
        const userRes = await client.query('SELECT id FROM users WHERE email = $1', [inviteEmail]);

        if (userRes.rows.length > 0) {
          return NextResponse.json({ error: 'User with this email already exists' }, { status: 400 });
        }

        const newMember = await client.query(
          `INSERT INTO users (org_id, email, role, supertokens_id) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id, email, role, created_at`,
          [orgId, inviteEmail, role, `invite_${Date.now()}`]
        );

        return NextResponse.json({ success: true, member: newMember.rows[0] });
      }

      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/settings POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
