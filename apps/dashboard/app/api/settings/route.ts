import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { lookupUserByEmail } from '@/lib/auth-user';
import { isValidEmail, normalizeEmail, randomToken, sha256Hex } from '@/lib/password';
import { appBaseUrl, sendTransactionalEmail } from '@/lib/mail';
import {
  loadWidgetSettings,
  parseAllowedOrigins,
  rotateWidgetSiteKey,
  updateWidgetAllowedOrigins,
} from '@/lib/widget-embed';

const INVITE_TTL_DAYS = 7;

type InviteRole = 'member' | 'admin';

function parseInviteRole(value: unknown): InviteRole | null {
  if (value === 'member' || value === 'admin') return value;
  if (value === undefined || value === null || value === '') return 'member';
  return null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled invite role: ${String(value)}`);
}

function roleLabel(role: InviteRole): string {
  switch (role) {
    case 'member':
      return 'member';
    case 'admin':
      return 'admin';
    default:
      return assertNever(role);
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const orgRes = await client.query(
        'SELECT id, name, slug, plan, status, created_at FROM orgs WHERE id = $1',
        [orgId]
      );
      const org = orgRes.rows[0] || null;

      const membersRes = await client.query(
        'SELECT id, email, role, created_at FROM users WHERE org_id = $1 ORDER BY created_at ASC',
        [orgId]
      );

      const invitesRes = await client.query(
        `SELECT id, email, role, expires_at, created_at
         FROM org_invites
         WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [orgId]
      );

      const appUrl = appBaseUrl();
      const webhookDetails = {
        chatwootWebhookUrl: `${appUrl}/api/webhooks/chatwoot?org_id=${orgId}`,
        metaWebhookUrl: `${appUrl}/api/webhooks/whatsapp`,
        verifyToken: process.env.VERIFY_TOKEN || null,
      };
      const widget = await loadWidgetSettings(client, orgId, appUrl);

      return NextResponse.json({
        org,
        members: membersRes.rows,
        pendingInvites: invitesRes.rows,
        webhookDetails,
        widget,
        mailConfigured: Boolean(process.env.RESEND_API_KEY),
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/settings GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = await request.json();
      if (body?.orgId || body?.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }
      const { action, orgName, inviteEmail, inviteRole, allowedOrigins } = body;

      if (action === 'update_org' && typeof orgName === 'string' && orgName.trim()) {
        await client.query('UPDATE orgs SET name = $1, updated_at = NOW() WHERE id = $2', [
          orgName.trim(),
          orgId,
        ]);
        return NextResponse.json({ success: true, message: 'Organization updated' });
      }

      if (action === 'invite_member') {
        if (typeof inviteEmail !== 'string' || !isValidEmail(inviteEmail)) {
          return NextResponse.json({ error: 'A valid invite email is required' }, { status: 400 });
        }
        const role = parseInviteRole(inviteRole);
        if (!role) {
          return NextResponse.json({ error: 'Invite role must be member or admin' }, { status: 400 });
        }

        const email = normalizeEmail(inviteEmail);
        const existing = await lookupUserByEmail(client, email);
        if (existing?.org_id === orgId) {
          return NextResponse.json(
            { error: 'That email is already a member of this organization' },
            { status: 400 }
          );
        }
        if (existing?.org_id && existing.org_id !== orgId) {
          return NextResponse.json(
            { error: 'This email already belongs to another organization' },
            { status: 409 }
          );
        }

        const token = randomToken();
        const tokenHash = sha256Hex(token);
        const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

        const updated = await client.query(
          `UPDATE org_invites
           SET role = $3, token_hash = $4, invited_by = $5, expires_at = $6
           WHERE org_id = $1 AND lower(email) = $2 AND accepted_at IS NULL
           RETURNING id`,
          [orgId, email, role, tokenHash, userId, expiresAt.toISOString()]
        );
        if (updated.rows.length === 0) {
          await client.query(
            `INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orgId, email, role, tokenHash, userId, expiresAt.toISOString()]
          );
        }

        const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
        const orgDisplayName = orgRes.rows[0]?.name || 'your organization';
        const inviteUrl = `${appBaseUrl()}/invite/${token}`;

        const mail = await sendTransactionalEmail({
          to: email,
          subject: `You were invited to ${orgDisplayName} on Darex`,
          text: [
            `You were invited to join ${orgDisplayName} as ${roleLabel(role)}.`,
            `Accept the invite: ${inviteUrl}`,
            `This link expires in ${INVITE_TTL_DAYS} days.`,
          ].join('\n'),
        });

        return NextResponse.json({
          success: true,
          emailSent: mail.sent,
          emailReason: mail.sent ? undefined : mail.reason,
          inviteUrl,
          member: { email, role, expires_at: expiresAt.toISOString() },
        });
      }

      if (action === 'rotate_widget_key') {
        const rotated = await rotateWidgetSiteKey(client, orgId, appBaseUrl());
        const widget = await loadWidgetSettings(client, orgId, appBaseUrl());
        return NextResponse.json({
          success: true,
          widget: { ...widget, siteKey: rotated.siteKey, snippet: rotated.snippet },
        });
      }

      if (action === 'update_widget_origins') {
        try {
          const origins = parseAllowedOrigins(allowedOrigins);
          const updated = await updateWidgetAllowedOrigins(client, orgId, origins);
          const widget = await loadWidgetSettings(client, orgId, appBaseUrl());
          return NextResponse.json({ success: true, widget: { ...widget, ...updated } });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Could not save origins';
          return NextResponse.json({ error: message }, { status: 400 });
        }
      }

      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/settings POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
