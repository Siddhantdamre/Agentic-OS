import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Session from 'supertokens-node/recipe/session';
import ThirdParty from 'supertokens-node/recipe/thirdparty';

let initialized = false;

type ProviderInput = {
  config: {
    thirdPartyId: string;
    name?: string;
    clients: Array<{
      clientId: string;
      clientSecret?: string;
      additionalConfig?: Record<string, string>;
    }>;
  };
};

export const SSO_PROVIDERS = ['saml', 'google-workspaces', 'microsoft', 'okta'] as const;

export type SsoProvider = (typeof SSO_PROVIDERS)[number];

export type SsoProviderInfo = {
  id: SsoProvider;
  thirdPartyId: string;
  name: string;
  configured: boolean;
  protocol: 'saml' | 'oidc';
};

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

function isNextBuild(): boolean {
  return process.env['NEXT_PHASE'] === 'phase-production-build';
}

export function parseSsoProvider(raw: string): SsoProvider | null {
  const p = raw.toLowerCase();
  switch (p) {
    case 'saml':
    case 'boxy-saml':
    case 'saml-test':
      return 'saml';
    case 'google':
    case 'google-workspaces':
    case 'google-workspace':
      return 'google-workspaces';
    case 'microsoft':
    case 'active-directory':
    case 'azure':
      return 'microsoft';
    case 'okta':
      return 'okta';
    default:
      return null;
  }
}

export function ssoThirdPartyId(provider: SsoProvider): string {
  switch (provider) {
    case 'saml':
      return 'boxy-saml';
    case 'google-workspaces':
      return 'google-workspaces';
    case 'microsoft':
      return 'active-directory';
    case 'okta':
      return 'okta';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function samlConfigured(): boolean {
  const boxyURL = process.env.SUPERTOKENS_SAML_BOXY_URL;
  const clientId = process.env.SUPERTOKENS_SAML_CLIENT_ID;
  const clientSecret = process.env.SUPERTOKENS_SAML_CLIENT_SECRET;
  if (isProduction() && !isNextBuild()) {
    return Boolean(boxyURL && clientId && clientSecret);
  }
  if (samlTestIdpEnabled()) return true;
  return Boolean(boxyURL && clientId && clientSecret);
}

/** Localhost Boxy + mocksaml defaults only when the operator opts in. Never in production. */
export function samlTestIdpEnabled(): boolean {
  return process.env.SUPERTOKENS_SAML_TEST_IDP === 'true' && !isProduction();
}

function buildSamlProvider(): ProviderInput | null {
  if (!samlConfigured()) return null;
  const test = samlTestIdpEnabled();
  const boxyURL = process.env.SUPERTOKENS_SAML_BOXY_URL || (test ? 'http://localhost:5225' : '');
  const clientId = process.env.SUPERTOKENS_SAML_CLIENT_ID || (test ? 'mock-saml' : '');
  const clientSecret = process.env.SUPERTOKENS_SAML_CLIENT_SECRET || (test ? 'mock-saml-secret' : '');
  if (!boxyURL || !clientId || !clientSecret) return null;
  return {
    config: {
      thirdPartyId: 'boxy-saml',
      name: test ? 'SAML (test IdP)' : 'SAML',
      clients: [
        {
          clientId,
          clientSecret,
          additionalConfig: { boxyURL },
        },
      ],
    },
  };
}

function buildGoogleWorkspacesProvider(): ProviderInput | null {
  const clientId = process.env.GOOGLE_WORKSPACE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_WORKSPACE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    config: {
      thirdPartyId: 'google-workspaces',
      name: 'Google Workspace',
      clients: [
        {
          clientId,
          clientSecret,
          additionalConfig: { hd: process.env.GOOGLE_WORKSPACE_HD || '*' },
        },
      ],
    },
  };
}

function buildMicrosoftProvider(): ProviderInput | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID || process.env.AZURE_AD_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || process.env.AZURE_AD_CLIENT_SECRET;
  const directoryId =
    process.env.AZURE_AD_DIRECTORY_ID || process.env.MICROSOFT_TENANT_ID || 'common';
  if (!clientId || !clientSecret) return null;
  return {
    config: {
      thirdPartyId: 'active-directory',
      name: 'Microsoft',
      clients: [
        {
          clientId,
          clientSecret,
          additionalConfig: { directoryId },
        },
      ],
    },
  };
}

function buildOktaProvider(): ProviderInput | null {
  const clientId = process.env.OKTA_CLIENT_ID;
  const clientSecret = process.env.OKTA_CLIENT_SECRET;
  const oktaDomain = process.env.OKTA_DOMAIN;
  if (!clientId || !clientSecret || !oktaDomain) return null;
  return {
    config: {
      thirdPartyId: 'okta',
      name: 'Okta',
      clients: [
        {
          clientId,
          clientSecret,
          additionalConfig: { oktaDomain },
        },
      ],
    },
  };
}

/** Additive SSO providers. Email+password remains in recipeList regardless. */
export function buildSsoProviders(): ProviderInput[] {
  const providers: ProviderInput[] = [];
  const saml = buildSamlProvider();
  if (saml) providers.push(saml);
  const google = buildGoogleWorkspacesProvider();
  if (google) providers.push(google);
  const microsoft = buildMicrosoftProvider();
  if (microsoft) providers.push(microsoft);
  const okta = buildOktaProvider();
  if (okta) providers.push(okta);
  return providers;
}

export function listSsoProviders(): SsoProviderInfo[] {
  const configured = new Set(buildSsoProviders().map((p) => p.config.thirdPartyId));
  return SSO_PROVIDERS.map((id) => {
    const thirdPartyId = ssoThirdPartyId(id);
    switch (id) {
      case 'saml':
        return {
          id,
          thirdPartyId,
          name: 'SAML',
          configured: configured.has(thirdPartyId),
          protocol: 'saml' as const,
        };
      case 'google-workspaces':
        return {
          id,
          thirdPartyId,
          name: 'Google Workspace',
          configured: configured.has(thirdPartyId),
          protocol: 'oidc' as const,
        };
      case 'microsoft':
        return {
          id,
          thirdPartyId,
          name: 'Microsoft',
          configured: configured.has(thirdPartyId),
          protocol: 'oidc' as const,
        };
      case 'okta':
        return {
          id,
          thirdPartyId,
          name: 'Okta',
          configured: configured.has(thirdPartyId),
          protocol: 'oidc' as const,
        };
      default: {
        const _exhaustive: never = id;
        return _exhaustive;
      }
    }
  });
}

export function ensureSuperTokensInit() {
  if (initialized) return;

  const isProd = isProduction();
  const connectionURI = process.env['SUPERTOKENS_CONNECTION_URI'];
  if (isProd && !isNextBuild() && !connectionURI) {
    throw new Error('SUPERTOKENS_CONNECTION_URI must be set in production');
  }

  try {
    supertokens.init({
      framework: 'custom',
      supertokens: {
        connectionURI: connectionURI || 'http://localhost:3567',
        apiKey: process.env.SUPERTOKENS_API_KEY,
      },
      appInfo: {
        appName: process.env.NEXT_PUBLIC_SUPERTOKENS_APP_NAME || 'DareX ai',
        apiDomain: process.env.NEXT_PUBLIC_SUPERTOKENS_API_DOMAIN || 'http://localhost:3000',
        websiteDomain: process.env.NEXT_PUBLIC_SUPERTOKENS_WEBSITE_DOMAIN || 'http://localhost:3000',
        apiBasePath: '/api/auth',
        websiteBasePath: '/login',
      },
      recipeList: [
        EmailPassword.init(),
        ThirdParty.init({
          signInAndUpFeature: {
            providers: buildSsoProviders(),
          },
        }),
        Session.init(),
      ],
    });
    initialized = true;
  } catch {
    initialized = true;
  }
}
