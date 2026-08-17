import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import ThirdParty from 'supertokens-node/recipe/thirdparty';
import { pool, createOrgForEmail, ensureUserOrg, getOrgScopedClient } from '@/lib/db';
import { applySessionCookies, PENDING_INVITE_COOKIE } from '@/lib/session-cookie';
import {
  acceptInviteToken,
  insertAuthUser,
  isOnboardingComplete,
  lookupInviteByToken,
  lookupUserByEmail,
  linkSuperTokensId,
} from '@/lib/auth-user';
import { normalizeEmail } from '@/lib/password';
import { recordAuditEvent } from '@/lib/inbound-confirm';
import {
  ensureSuperTokensInit,
  parseSsoProvider,
  ssoThirdPartyId,
} from '@/lib/supertokens';

export const dynamic = 'force-dynamic';

const SSO_STATE_COOKIE = (provider: string) => `sso_state_${provider}`;
const SSO_PKCE_COOKIE = (provider: string) => `sso_pkce_${provider}`;

function clearSsoCookies(res: NextResponse, provider: string): void {
  res.cookies.delete(SSO_STATE_COOKIE(provider));
  res.cookies.delete(SSO_PKCE_COOKIE(provider));
  res.cookies.delete(PENDING_INVITE_COOKIE);
}

function redirectLogin(origin: string, error: string): NextResponse {
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', error);
  return NextResponse.redirect(loginUrl);
}

/**
 * GET /api/auth/sso/callback/[provider]
 * Completes SuperTokens ThirdParty SAML/OIDC and issues the Darex session cookie.
 * Does not replace EmailPassword. Does not use demo OAuth.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  ensureSuperTokensInit();
  const { provider: rawProvider } = await params;
  const provider = parseSsoProvider(rawProvider);
  const url = new URL(request.url);

  if (!provider) {
    return redirectLogin(url.origin, 'Unsupported SSO provider');
  }

  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    return redirectLogin(url.origin, `SSO denied: ${errorParam}`);
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(SSO_STATE_COOKIE(provider))?.value;
  const state = url.searchParams.get('state') || '';
  if (!savedState || !state || savedState !== state) {
    return redirectLogin(url.origin, 'Invalid SSO state. Please try again.');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;
  const redirectURIOnProviderDashboard = `${appUrl}/api/auth/sso/callback/${provider}`;
  const pkceCodeVerifier = cookieStore.get(SSO_PKCE_COOKIE(provider))?.value;
  const pendingInvite = cookieStore.get(PENDING_INVITE_COOKIE)?.value;

  try {
    const tp = await ThirdParty.getProvider('public', ssoThirdPartyId(provider), undefined);
    if (!tp) {
      return redirectLogin(url.origin, `${provider} SSO is not registered in SuperTokens`);
    }

    const redirectURIQueryParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      redirectURIQueryParams[key] = value;
    });

    const oAuthTokens = await tp.exchangeAuthCodeForOAuthTokens({
      redirectURIInfo: {
        redirectURIOnProviderDashboard,
        redirectURIQueryParams,
        pkceCodeVerifier,
      },
      userContext: {} as never,
    });
    const userInfo = await tp.getUserInfo({ oAuthTokens, userContext: {} as never });
    const email = userInfo.email?.id ? normalizeEmail(userInfo.email.id) : '';
    if (!email) {
      return redirectLogin(url.origin, 'SSO IdP did not return an email');
    }

    const st = await ThirdParty.manuallyCreateOrUpdateUser(
      'public',
      ssoThirdPartyId(provider),
      userInfo.thirdPartyUserId,
      email,
      userInfo.email?.isVerified ?? true
    );
    if (st.status !== 'OK') {
      return redirectLogin(url.origin, `SSO sign-in not allowed (${st.status})`);
    }

    const client = await pool.connect();
    try {
      const existing = await lookupUserByEmail(client, email);
      let userId: string;
      let orgId: string;
      let isNew = false;
      if (existing) {
        userId = existing.id;
        orgId = existing.org_id || (await ensureUserOrg(client, userId, email));
        await linkSuperTokensId(client, userId, st.user.id);
      } else {
        isNew = true;
        orgId = await createOrgForEmail(client, email);
        userId = await insertAuthUser(client, {
          orgId,
          email,
          role: 'owner',
          supertokensId: st.user.id,
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

      const onboardingComplete = isNew ? false : await isOnboardingComplete(client, orgId);
      const dest = new URL(onboardingComplete ? '/' : '/onboarding/name', url.origin);
      const res = NextResponse.redirect(dest);
      await applySessionCookies(res, { userId, orgId, onboardingComplete });
      clearSsoCookies(res, provider);

      try {
        const scoped = await getOrgScopedClient(orgId);
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'login',
              actor: { actorType: 'user', userId },
              resultStatus: 'ok',
              payload: { method: 'sso', provider },
            },
            { client: scoped.client, orgId: scoped.orgId }
          );
        } finally {
          scoped.client.release();
        }
      } catch (auditErr: unknown) {
        const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn('[sso] audit login skipped:', message);
      }

      return res;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sso] callback ${provider}:`, message);
    return redirectLogin(url.origin, `SSO failed: ${message.slice(0, 180)}`);
  }
}
