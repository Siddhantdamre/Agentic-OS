import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Session from 'supertokens-node/recipe/session';

let initialized = false;

export function ensureSuperTokensInit() {
  if (initialized) return;

  const isProd = process.env.NODE_ENV === 'production';
  const connectionURI = process.env.SUPERTOKENS_CONNECTION_URI;
  if (isProd && !connectionURI) {
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
      recipeList: [EmailPassword.init(), Session.init()],
    });
    initialized = true;
  } catch {
    initialized = true;
  }
}
