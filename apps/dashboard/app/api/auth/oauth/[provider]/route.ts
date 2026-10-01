import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { pool, createOrgForEmail } from '@/lib/db';
import {
  cookieSecure,
  PENDING_INVITE_COOKIE,
} from '@/lib/session-cookie';
import { issueSessionCookies } from '@/lib/session-epoch';
import {
  demoAuthAllowed,
  getAuthorizationUrl,
  getOAuthClientId,
  parseOAuthProvider,
  resolveAppUrl,
} from '@/lib/oauth-providers';
import { insertAuthUser, isOnboardingComplete, lookupUserByEmail } from '@/lib/auth-user';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'oauth');
  if (limited) return limited;

  const { provider: rawProvider } = await params;
  const provider = parseOAuthProvider(rawProvider);
  const appUrl = resolveAppUrl(request);

  if (!provider) {
    const loginUrl = new URL('/login', appUrl);
    loginUrl.searchParams.set('error', 'Unsupported OAuth provider');
    return NextResponse.redirect(loginUrl);
  }

  const redirectUri = `${appUrl}/api/auth/oauth/callback/${rawProvider}`;
  const state = crypto.randomBytes(16).toString('hex');
  const clientId = getOAuthClientId(provider);
  const inviteToken = new URL(request.url).searchParams.get('invite') || undefined;

  if (clientId) {
    const authUrl = getAuthorizationUrl(provider, clientId, redirectUri, state);
    const res = NextResponse.redirect(authUrl);
    const cookieBase = {
      httpOnly: true as const,
      secure: cookieSecure(),
      path: '/',
      maxAge: 600,
      sameSite: 'lax' as const,
    };
    res.cookies.set(`oauth_state_${rawProvider}`, state, cookieBase);
    if (inviteToken) {
      res.cookies.set(PENDING_INVITE_COOKIE, inviteToken, cookieBase);
    }
    return res;
  }

  if (!demoAuthAllowed()) {
    const loginUrl = new URL('/login', appUrl);
    loginUrl.searchParams.set(
      'error',
      `${provider} OAuth is not configured. Set the client ID/secret env vars.`
    );
    return NextResponse.redirect(loginUrl);
  }

  const client = await pool.connect();
  try {
    const demoEmail = `owner.${provider}@demo.darex.ai`;
    let userId: string;
    let orgId: string;
    const existing = await lookupUserByEmail(client, demoEmail);
    if (existing) {
      userId = existing.id;
      orgId = existing.org_id || (await createOrgForEmail(client, demoEmail));
    } else {
      orgId = await createOrgForEmail(client, demoEmail);
      userId = await insertAuthUser(client, {
        orgId,
        email: demoEmail,
        role: 'owner',
        supertokensId: `oauth_${provider}_${crypto.randomUUID()}`,
        passwordHash: null,
      });
    }
    const onboardingComplete = await isOnboardingComplete(client, orgId);
    const res = NextResponse.redirect(
      new URL(onboardingComplete ? '/' : '/onboarding/name', appUrl)
    );
    await issueSessionCookies(res, { userId, orgId, onboardingComplete });
    return res;
  } finally {
    client.release();
  }
}

