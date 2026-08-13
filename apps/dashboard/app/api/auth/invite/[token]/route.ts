import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { pool } from '@/lib/db';
import { acceptInviteToken, lookupInviteByToken, lookupUserById } from '@/lib/auth-user';
import { applySessionCookies, parseSessionCookie, SESSION_COOKIE } from '@/lib/session-cookie';
import { normalizeEmail } from '@/lib/password';

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
  const { token } = await params;
  const cookieStore = await cookies();
  const userId = await parseSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

    const res = NextResponse.json({
      status: 'OK',
      orgId: accepted.orgId,
      role: accepted.role,
      onboardingComplete: true,
    });
    await applySessionCookies(res, {
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
