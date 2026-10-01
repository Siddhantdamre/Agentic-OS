import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { pool } from '@/lib/db';
import { acceptInviteToken, lookupInviteByToken, lookupUserById } from '@/lib/auth-user';
import { parseSessionCookieParts, SESSION_COOKIE } from '@/lib/session-cookie';
import { issueSessionCookies } from '@/lib/session-epoch';
import { normalizeEmail } from '@/lib/password';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { recordAuditEvent } from '@/lib/audit-events';
import { upsertOrgMembership } from '@/lib/auth-security';

function inviteExpired(expiresAt: Date | string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const client = await pool.connect();
  try {
    const invite = await lookupInviteByToken(client, token);
    if (!invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json({ error: 'Invite already accepted' }, { status: 409 });
    }
    if (inviteExpired(invite.expires_at)) {
      return NextResponse.json({ error: 'Invite expired', expired: true }, { status: 410 });
    }
    return NextResponse.json({
      email: invite.email,
      role: invite.role,
      orgName: invite.org_name,
      expiresAt: invite.expires_at,
    });
  } finally {
    client.release();
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const limited = denyAuthIfLimited(clientIpFromRequest(_request), 'invite');
  if (limited) return limited;

  const { token } = await params;
  const cookieStore = await cookies();
  const session = await parseSessionCookieParts(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { userId, epoch: cookieEpoch } = session;

  const client = await pool.connect();
  try {
    const invite = await lookupInviteByToken(client, token);
    if (!invite) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    if (invite.accepted_at) {
      return NextResponse.json({ error: 'Invite already accepted' }, { status: 409 });
    }
    if (inviteExpired(invite.expires_at)) {
      return NextResponse.json({ error: 'Invite expired', expired: true }, { status: 410 });
    }

    const user = await lookupUserById(client, userId);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let sessionEpoch = 0;
    try {
      const epochRes = await client.query<{ session_epoch: number }>(
        `SELECT session_epoch FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      sessionEpoch = Number(epochRes.rows[0]?.session_epoch ?? 0);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== '42703') throw err;
      sessionEpoch = 0;
    }
    if (cookieEpoch !== sessionEpoch) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
      return NextResponse.json(
        { error: 'This invite was sent to a different email address.' },
        { status: 403 }
      );
    }

    const accepted = await acceptInviteToken(client, token, userId);
    if (accepted.orgId !== invite.org_id) {
      return NextResponse.json({ error: 'Invite org mismatch' }, { status: 409 });
    }

    await upsertOrgMembership(client, userId, accepted.orgId, accepted.role || invite.role, true);
    try {
      await recordAuditEvent({
        orgId: accepted.orgId,
        kind: 'invite.accept',
        actor: { actorType: 'user', userId },
        action: 'invite.accept',
        resultStatus: 'ok',
      });
    } catch {
      // best-effort
    }

    const res = NextResponse.json({
      status: 'OK',
      orgId: accepted.orgId,
      role: accepted.role,
      onboardingComplete: true,
    });
    await issueSessionCookies(res, {
      userId,
      orgId: accepted.orgId,
      onboardingComplete: true,
    });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to accept invite';
    if (message.includes('INVITE_EXPIRED')) {
      return NextResponse.json({ error: 'Invite expired', expired: true }, { status: 410 });
    }
    if (message.includes('INVITE_ALREADY_ACCEPTED')) {
      return NextResponse.json({ error: 'Invite already accepted' }, { status: 409 });
    }
    if (message.includes('USER_ALREADY_IN_ORG')) {
      return NextResponse.json(
        { error: 'This account already belongs to another organization.' },
        { status: 409 }
      );
    }
    if (message.includes('INVITE_EMAIL_MISMATCH')) {
      return NextResponse.json(
        { error: 'This invite was sent to a different email address.' },
        { status: 403 }
      );
    }
    if (message.includes('INVITE_NOT_FOUND')) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    console.error('Accept invite error:', err);
    return NextResponse.json({ error: 'Failed to accept invite' }, { status: 500 });
  } finally {
    client.release();
  }
}
