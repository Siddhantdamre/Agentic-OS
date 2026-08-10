import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { pool, createOrgForEmail } from '@/lib/db';

function getOAuthClientId(provider: string): string | undefined {
  switch (provider.toLowerCase()) {
    case 'google':
      return process.env.GOOGLE_CLIENT_ID;
    case 'github':
      return process.env.GITHUB_CLIENT_ID;
    case 'facebook':
    case 'meta':
      return process.env.META_APP_ID;
    case 'microsoft':
      return process.env.MICROSOFT_CLIENT_ID;
    default:
      return undefined;
  }
}

function getOAuthClientSecret(provider: string): string | undefined {
  switch (provider.toLowerCase()) {
    case 'google':
      return process.env.GOOGLE_CLIENT_SECRET;
    case 'github':
      return process.env.GITHUB_CLIENT_SECRET;
    case 'facebook':
    case 'meta':
      return process.env.META_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET;
    case 'microsoft':
      return process.env.MICROSOFT_CLIENT_SECRET;
    default:
      return undefined;
  }
}

function getAuthorizationUrl(
  provider: string,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  switch (provider.toLowerCase()) {
    case 'google':
      return (
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email profile',
          access_type: 'offline',
          prompt: 'consent',
          state,
        }).toString()
      );
    case 'github':
      return (
        `https://github.com/login/oauth/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'user:email read:user',
          state,
        }).toString()
      );
    case 'facebook':
    case 'meta':
      return (
        `https://www.facebook.com/v19.0/dialog/oauth?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: 'email,public_profile',
          state,
        }).toString()
      );
    case 'microsoft':
      return (
        `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email profile User.Read',
          state,
        }).toString()
      );
    default:
      return redirectUri;
  }
}

// ── GET: Initiate OAuth flow ───────────────────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const url = new URL(request.url);

  // Use explicit APP_URL env if set — must match what's registered in Google/Meta console exactly
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;
  const redirectUri = `${appUrl}/api/auth/oauth/callback/${provider}`;
  const state = crypto.randomBytes(16).toString('hex');
  const clientId = getOAuthClientId(provider);

  // Log so you can see exactly what URI is being sent
  console.log(`[OAuth] Initiating ${provider} → redirect_uri: ${redirectUri}`);

  if (clientId) {
    // Real OAuth: redirect to provider's authorization URL
    const authUrl = getAuthorizationUrl(provider, clientId, redirectUri, state);
    const res = NextResponse.redirect(authUrl);
    res.cookies.set(`oauth_state_${provider}`, state, {
      httpOnly: true,
      path: '/',
      maxAge: 600,
      sameSite: 'lax',
    });
    return res;
  }

  // Demo fallback only when explicitly enabled via ALLOW_DEMO_AUTH=true
  if (process.env.ALLOW_DEMO_AUTH !== 'true') {
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('error', `${provider} OAuth is not configured. Set the client ID/secret env vars.`);
    return NextResponse.redirect(loginUrl);
  }

  // Demo fallback: auto-provision and log in
  const client = await pool.connect();
  try {
    const demoEmail = `owner.${provider}@demo.darex.ai`;

    let userId: string;
    let orgId: string;

    const userRes = await client.query(`SELECT id, org_id FROM users WHERE email = $1 LIMIT 1`, [
      demoEmail,
    ]);
    if (userRes.rows.length > 0) {
      userId = userRes.rows[0].id;
      orgId = userRes.rows[0].org_id || (await createOrgForEmail(client, demoEmail));
    } else {
      orgId = await createOrgForEmail(client, demoEmail);
      const newUser = await client.query(
        `INSERT INTO users (org_id, email, role, supertokens_id)
         VALUES ($1, $2, 'owner', $3)
         RETURNING id`,
        [orgId, demoEmail, `oauth_${provider}_${crypto.randomUUID()}`]
      );
      userId = newUser.rows[0].id;
    }

    const res = NextResponse.redirect(new URL('/', url.origin));
    res.cookies.set('darex_session', userId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    res.cookies.set('darex_org_id', orgId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } finally {
    client.release();
  }
}
