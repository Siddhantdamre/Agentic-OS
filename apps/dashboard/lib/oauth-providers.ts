export const OAUTH_PROVIDERS = ['google', 'github', 'facebook', 'meta', 'microsoft'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function parseOAuthProvider(raw: string): OAuthProvider | null {
  const p = raw.toLowerCase();
  switch (p) {
    case 'google':
    case 'github':
    case 'facebook':
    case 'meta':
    case 'microsoft':
      return p;
    default:
      return null;
  }
}

/**
 * Demo OAuth auto-provision. Production always returns false; boot-guards
 * refuse process start if ALLOW_DEMO_AUTH=true under NODE_ENV=production.
 */
export function demoAuthAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.ALLOW_DEMO_AUTH === 'true';
}

export function getOAuthClientId(provider: OAuthProvider): string | undefined {
  switch (provider) {
    case 'google':
      return process.env.GOOGLE_CLIENT_ID;
    case 'github':
      return process.env.GITHUB_CLIENT_ID;
    case 'facebook':
    case 'meta':
      return process.env.META_APP_ID;
    case 'microsoft':
      return process.env.MICROSOFT_CLIENT_ID;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function getOAuthClientSecret(provider: OAuthProvider): string | undefined {
  switch (provider) {
    case 'google':
      return process.env.GOOGLE_CLIENT_SECRET;
    case 'github':
      return process.env.GITHUB_CLIENT_SECRET;
    case 'facebook':
    case 'meta':
      return process.env.META_APP_SECRET || process.env.FACEBOOK_CLIENT_SECRET;
    case 'microsoft':
      return process.env.MICROSOFT_CLIENT_SECRET;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function getAuthorizationUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  switch (provider) {
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
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function getOAuthTokenUrl(provider: OAuthProvider): string {
  switch (provider) {
    case 'google':
      return 'https://oauth2.googleapis.com/token';
    case 'github':
      return 'https://github.com/login/oauth/access_token';
    case 'facebook':
    case 'meta':
      return 'https://graph.facebook.com/v19.0/oauth/access_token';
    case 'microsoft':
      return 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
