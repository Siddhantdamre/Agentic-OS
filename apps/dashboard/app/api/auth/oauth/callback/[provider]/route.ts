import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { cookies } from 'next/headers';
import { pool, createOrgForEmail, ensureUserOrg } from '@/lib/db';
import { applySessionCookies, PENDING_INVITE_COOKIE } from '@/lib/session-cookie';
import {
  demoAuthAllowed,
  getOAuthClientId,
  getOAuthClientSecret,
  getOAuthTokenUrl,
  parseOAuthProvider,
  type OAuthProvider,
} from '@/lib/oauth-providers';
import {
  acceptInviteToken,
  insertAuthUser,
  isOnboardingComplete,
  lookupInviteByToken,
  lookupUserByEmail,
} from '@/lib/auth-user';
import { normalizeEmail } from '@/lib/password';

function getClientCredentials(provider: OAuthProvider): { clientId?: string; clientSecret?: string } {
  return {
    clientId: getOAuthClientId(provider),
    clientSecret: getOAuthClientSecret(provider),
  };
}

async function getUserInfo(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{ email: string; name?: string; externalId?: string }> {
  const tokenBody: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };

  switch (provider) {
    case 'google':
    case 'facebook':
    case 'meta':
      break;
    case 'github':
      delete tokenBody.grant_type;
      break;
    case 'microsoft':
      tokenBody.scope = 'openid email profile User.Read';
      break;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }

  const tokenUrl = getOAuthTokenUrl(provider);
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(tokenBody).toString(),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
  }

  const accessToken = tokenData.access_token as string;

  switch (provider) {
    case 'google': {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const u = (await r.json()) as { email?: string; name?: string; sub?: string };
      return { email: u.email || '', name: u.name, externalId: u.sub };
    }
    case 'github': {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      const u = (await r.json()) as { email?: string; name?: string; login?: string; id?: number };
      let email = u.email;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        const emails = await emailsRes.json();
        if (Array.isArray(emails)) {
          const typed = emails as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
          const primary = typed.find((e) => e.primary && e.verified);
          email = primary?.email || typed[0]?.email;
        }
      }
      return {
        email: email || `${u.login}@github.users.noreply.com`,
        name: u.name || u.login,
        externalId: String(u.id),
      };
    }
    case 'facebook':
    case 'meta': {
      const r = await fetch(
        `https://graph.facebook.com/me?fields=email,name&access_token=${accessToken}`
      );
      const u = (await r.json()) as { email?: string; name?: string; id?: string };
      return { email: u.email || '', name: u.name, externalId: u.id };
    }
    case 'microsoft': {
      const r = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const u = (await r.json()) as {
        mail?: string;
        userPrincipalName?: string;
        displayName?: string;
        id?: string;
      };
      return {
        email: u.mail || u.userPrincipalName || '',
        name: u.displayName,
        externalId: u.id,
      };
    }
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

async function finishOAuthLogin(
  origin: string,
  rawProvider: string,
  userId: string,
  orgId: string,
  onboardingComplete: boolean
) {
  const dest = onboardingComplete ? '/' : '/onboarding/name';
  const res = NextResponse.redirect(new URL(dest, origin));
  res.cookies.delete(`oauth_state_${rawProvider}`);
  res.cookies.delete(PENDING_INVITE_COOKIE);
  await applySessionCookies(res, { userId, orgId, onboardingComplete });
  return res;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: rawProvider } = await params;
  const provider = parseOAuthProvider(rawProvider);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const loginUrl = new URL('/login', url.origin);

  if (!provider) {
    loginUrl.searchParams.set('error', 'Unsupported OAuth provider');
    return NextResponse.redirect(loginUrl);
  }

  if (errorParam) {
    loginUrl.searchParams.set('error', `OAuth denied: ${errorParam}`);
    return NextResponse.redirect(loginUrl);
  }

  if (!code) {
    loginUrl.searchParams.set('error', 'No authorization code received from provider');
    return NextResponse.redirect(loginUrl);
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(`oauth_state_${rawProvider}`)?.value;
  if (!savedState || !state || savedState !== state) {
    loginUrl.searchParams.set('error', 'Invalid OAuth state. Please try again.');
    return NextResponse.redirect(loginUrl);
  }
  const pendingInvite = cookieStore.get(PENDING_INVITE_COOKIE)?.value;

  const { clientId, clientSecret } = getClientCredentials(provider);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;
  const redirectUri = `${appUrl}/api/auth/oauth/callback/${rawProvider}`;

  if (!clientId || !clientSecret) {
    if (!demoAuthAllowed()) {
      loginUrl.searchParams.set(
        'error',
        `${provider} OAuth is not configured. Set the client ID/secret env vars.`
      );
      return NextResponse.redirect(loginUrl);
    }

    const client = await pool.connect();
    try {
      const demoEmail = `demo.${provider}@darex.ai`;
      const existing = await lookupUserByEmail(client, demoEmail);
      let userId: string;
      let orgId: string;
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
      return finishOAuthLogin(url.origin, rawProvider, userId, orgId, onboardingComplete);
    } finally {
      client.release();
    }
  }

  const client = await pool.connect();
  try {
    const { email: rawEmail, name, externalId } = await getUserInfo(
      provider,
      code,
      redirectUri,
      clientId,
      clientSecret
    );
    const email = rawEmail ? normalizeEmail(rawEmail) : '';

    if (!email) {
      loginUrl.searchParams.set('error', 'Could not retrieve email from provider');
      return NextResponse.redirect(loginUrl);
    }

    const existingUser = await lookupUserByEmail(client, email);
    let userId: string;
    let orgId: string;
    let isNew = false;
    if (existingUser) {
      userId = existingUser.id;
      orgId = existingUser.org_id || (await ensureUserOrg(client, userId, email));
    } else {
      isNew = true;
      orgId = await createOrgForEmail(client, email);
      userId = await insertAuthUser(client, {
        orgId,
        email,
        role: 'owner',
        supertokensId: externalId || `oauth_${provider}_${crypto.randomUUID()}`,
        passwordHash: null,
      });
    }

    if (pendingInvite) {
      const invite = await lookupInviteByToken(client, pendingInvite);
      if (invite && normalizeEmail(invite.email) === email) {
        try {
          const accepted = await acceptInviteToken(client, pendingInvite, userId);
          orgId = accepted.orgId;
          isNew = false;
        } catch {
          // keep original org if invite cannot be accepted
        }
      }
    }

    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    await client
      .query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'oauth_callback', 'success', 200, $3, $4)`,
        [
          orgId,
          provider,
          `OAuth login via ${provider} for ${email}`,
          JSON.stringify({ userId, email, name, provider }),
        ]
      )
      .catch(() => undefined);

    const onboardingComplete = isNew ? false : await isOnboardingComplete(client, orgId);
    return finishOAuthLogin(url.origin, rawProvider, userId, orgId, onboardingComplete);
  } catch (err) {
    console.error(`OAuth Callback Error (${provider}):`, err);
    loginUrl.searchParams.set(
      'error',
      err instanceof Error ? err.message : 'Authentication failed. Please try again.'
    );
    return NextResponse.redirect(loginUrl);
  } finally {
    client.release();
  }
}

