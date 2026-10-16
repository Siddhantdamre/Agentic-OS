import { NextResponse } from 'next/server';
import ThirdParty from 'supertokens-node/recipe/thirdparty';
import { PENDING_INVITE_COOKIE, cookieSecure } from '@/lib/session-cookie';
import {
  ensureSuperTokensInit,
  listSsoProviders,
  parseSsoProvider,
  ssoThirdPartyId,
} from '@/lib/supertokens';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { resolveAppUrl } from '@/lib/oauth-providers';

export const dynamic = 'force-dynamic';

const SSO_STATE_COOKIE = (provider: string) => `sso_state_${provider}`;
const SSO_PKCE_COOKIE = (provider: string) => `sso_pkce_${provider}`;

/**
 * GET /api/auth/sso/[provider] — start SuperTokens SAML/OIDC redirect.
 * Password path is not involved. Unsigned/forged is N/A here (browser redirect).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'sso');
  if (limited) return limited;

  ensureSuperTokensInit();
  const { provider: rawProvider } = await params;
  const provider = parseSsoProvider(rawProvider);
  const url = new URL(request.url);
  const appUrl = resolveAppUrl(request);
  const loginUrl = new URL('/login', appUrl);

  if (!provider) {
    loginUrl.searchParams.set('error', 'Unsupported SSO provider');
    return NextResponse.redirect(loginUrl);
  }

  const info = listSsoProviders().find((p) => p.id === provider);
  if (!info?.configured) {
    loginUrl.searchParams.set(
      'error',
      `${info?.name || provider} SSO is not configured. Set SuperTokens SAML/OIDC env vars (test IdP: SUPERTOKENS_SAML_TEST_IDP=true).`
    );
    return NextResponse.redirect(loginUrl);
  }

  const redirectURIOnProviderDashboard = `${appUrl}/api/auth/sso/callback/${provider}`;
  const inviteToken = url.searchParams.get('invite') || undefined;

  try {
    const tp = await ThirdParty.getProvider('public', ssoThirdPartyId(provider), undefined);
    if (!tp) {
      loginUrl.searchParams.set('error', `${provider} SSO provider is not registered in SuperTokens`);
      return NextResponse.redirect(loginUrl);
    }
    const auth = await tp.getAuthorisationRedirectURL({
      redirectURIOnProviderDashboard,
      userContext: {} as never,
    });
    const res = NextResponse.redirect(auth.urlWithQueryParams);
    const cookieBase = {
      httpOnly: true,
      secure: cookieSecure(),
      path: '/',
      maxAge: 600,
      sameSite: 'lax' as const,
    };
    const state = new URL(auth.urlWithQueryParams).searchParams.get('state') || '';
    if (state) {
      res.cookies.set(SSO_STATE_COOKIE(provider), state, cookieBase);
    }
    if (auth.pkceCodeVerifier) {
      res.cookies.set(SSO_PKCE_COOKIE(provider), auth.pkceCodeVerifier, cookieBase);
    }
    if (inviteToken) {
      res.cookies.set(PENDING_INVITE_COOKIE, inviteToken, cookieBase);
    }
    return res;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sso] start ${provider}:`, message);
    loginUrl.searchParams.set('error', 'SSO start failed. Please try again.');
    return NextResponse.redirect(loginUrl);
  }
}
