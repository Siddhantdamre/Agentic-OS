import { NextResponse } from 'next/server';
import { ensureSuperTokensInit, listSsoProviders, samlTestIdpEnabled } from '@/lib/supertokens';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/sso — list SSO providers (SAML/OIDC). Password login is unchanged.
 */
export async function GET() {
  ensureSuperTokensInit();
  return NextResponse.json({
    providers: listSsoProviders(),
    passwordEnabled: true,
    testIdp: samlTestIdpEnabled(),
  });
}
