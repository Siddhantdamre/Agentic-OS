import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { pool, createOrgForEmail, ensureUserOrg } from '@/lib/db';

function getClientCredentials(provider: string): { clientId?: string; clientSecret?: string } {
  switch (provider.toLowerCase()) {
    case 'google':
      return {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      };
    case 'github':
      return {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
      };
    case 'facebook':
    case 'meta':
      return {
        clientId: process.env.META_APP_ID,
        clientSecret: process.env.META_APP_SECRET,
      };
    case 'microsoft':
      return {
        clientId: process.env.MICROSOFT_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      };
    default:
      return {};
  }
}

async function getUserInfo(
  provider: string,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{ email: string; name?: string; externalId?: string }> {
  let tokenUrl = '';
  let tokenBody: Record<string, string> = {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  };

  switch (provider.toLowerCase()) {
    case 'google':
      tokenUrl = 'https://oauth2.googleapis.com/token';
      break;
    case 'github':
      tokenUrl = 'https://github.com/login/oauth/access_token';
      delete tokenBody.grant_type;
      break;
    case 'facebook':
    case 'meta':
      tokenUrl = 'https://graph.facebook.com/v19.0/oauth/access_token';
      break;
    case 'microsoft':
      tokenUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
      tokenBody.scope = 'openid email profile User.Read';
      break;
  }

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

  const accessToken = tokenData.access_token;

  if (provider === 'google') {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const u = await r.json();
    return { email: u.email, name: u.name, externalId: u.sub };
  }

  if (provider === 'github') {
    const r = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const u = await r.json();
    let email = u.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      const emails = await emailsRes.json();
      if (Array.isArray(emails)) {
        const primary = emails.find((e: any) => e.primary && e.verified);
        email = primary?.email || emails[0]?.email;
      }
    }
    return { email: email || `${u.login}@github.users.noreply.com`, name: u.name || u.login, externalId: String(u.id) };
  }

  if (provider === 'facebook' || provider === 'meta') {
    const r = await fetch(
      `https://graph.facebook.com/me?fields=email,name&access_token=${accessToken}`
    );
    const u = await r.json();
    return { email: u.email, name: u.name, externalId: u.id };
  }

  if (provider === 'microsoft') {
    const r = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const u = await r.json();
    return {
      email: u.mail || u.userPrincipalName,
      name: u.displayName,
      externalId: u.id,
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// ── GET: Handle OAuth Callback from Provider ────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  const loginUrl = new URL('/login', url.origin);

  if (errorParam) {
    loginUrl.searchParams.set('error', `OAuth denied: ${errorParam}`);
    return NextResponse.redirect(loginUrl);
  }

  if (!code) {
    loginUrl.searchParams.set('error', 'No authorization code received from provider');
    return NextResponse.redirect(loginUrl);
  }

  // Validate CSRF state
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const savedState = cookieStore.get(`oauth_state_${provider}`)?.value;
  if (savedState && state && savedState !== state) {
    loginUrl.searchParams.set('error', 'Invalid OAuth state. Please try again.');
    return NextResponse.redirect(loginUrl);
  }

  const { clientId, clientSecret } = getClientCredentials(provider);

  // Must match the redirect_uri sent during authorization EXACTLY
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;
  const redirectUri = `${appUrl}/api/auth/oauth/callback/${provider}`;
  console.log(`[OAuth Callback] ${provider} → redirect_uri: ${redirectUri}`);

  if (!clientId || !clientSecret) {
    // No credentials configured — demo fallback only when explicitly enabled
    if (process.env.ALLOW_DEMO_AUTH !== 'true') {
      loginUrl.searchParams.set('error', `${provider} OAuth is not configured. Set the client ID/secret env vars.`);
      return NextResponse.redirect(loginUrl);
    }

    const client = await pool.connect();
    try {
      const demoEmail = `demo.${provider}@darex.ai`;
      const userRes = await client.query(`SELECT id, org_id FROM users WHERE email = $1`, [demoEmail]);
      let userId: string;
      let orgId: string;
      if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
        orgId = userRes.rows[0].org_id || (await createOrgForEmail(client, demoEmail));
      } else {
        orgId = await createOrgForEmail(client, demoEmail);
        const nu = await client.query(
          `INSERT INTO users (org_id, email, role, supertokens_id) VALUES ($1, $2, 'owner', $3) RETURNING id`,
          [orgId, demoEmail, `oauth_${provider}_${crypto.randomUUID()}`]
        );
        userId = nu.rows[0].id;
      }
      const res = NextResponse.redirect(new URL('/', url.origin));
      res.cookies.delete(`oauth_state_${provider}`);
      res.cookies.set('darex_session', userId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400 * 7 });
      res.cookies.set('darex_org_id', orgId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 86400 * 7 });
      return res;
    } finally {
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    const { email, name, externalId } = await getUserInfo(
      provider,
      code,
      redirectUri,
      clientId,
      clientSecret
    );

    if (!email) {
      loginUrl.searchParams.set('error', 'Could not retrieve email from provider');
      return NextResponse.redirect(loginUrl);
    }

    const existingUser = await client.query(`SELECT id, org_id FROM users WHERE email = $1 LIMIT 1`, [email]);
    let userId: string;
    let orgId: string;
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      orgId = existingUser.rows[0].org_id || (await ensureUserOrg(client, userId, email));
    } else {
      orgId = await createOrgForEmail(client, email);
      const newUser = await client.query(
        `INSERT INTO users (org_id, email, role, supertokens_id)
         VALUES ($1, $2, 'owner', $3)
         RETURNING id`,
        [orgId, email, externalId || `oauth_${provider}_${crypto.randomUUID()}`]
      );
      userId = newUser.rows[0].id;
    }

    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    // Log the OAuth callback
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, 'oauth_callback', 'success', 200, $3, $4)`,
      [orgId, provider, `OAuth login via ${provider} for ${email}`, JSON.stringify({ userId, email, name, provider })]
    ).catch(() => {}); // non-critical, don't block login

    const res = NextResponse.redirect(new URL('/', url.origin));
    res.cookies.delete(`oauth_state_${provider}`);
    res.cookies.set('darex_session', userId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 86400 * 7,
    });
    res.cookies.set('darex_org_id', orgId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 86400 * 7,
    });
    return res;
  } catch (err: any) {
    console.error(`OAuth Callback Error (${provider}):`, err);
    loginUrl.searchParams.set('error', err.message || 'Authentication failed. Please try again.');
    return NextResponse.redirect(loginUrl);
  } finally {
    client.release();
  }
}
