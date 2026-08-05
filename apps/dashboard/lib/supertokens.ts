import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import Session from 'supertokens-node/recipe/session';
import DashboardRecipe from 'supertokens-node/recipe/dashboard';

let initialized = false;

export function ensureSuperTokensInit() {
  if (initialized) return;

  try {
    supertokens.init({
      framework: 'custom',
      supertokens: {
        connectionURI: process.env.SUPERTOKENS_CONNECTION_URI || 'http://localhost:3567',
        apiKey: process.env.SUPERTOKENS_API_KEY || 'darex-supertokens-api-key-dev',
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
        Session.init(),
        DashboardRecipe.init(),
      ],
    });
    initialized = true;
  } catch (e) {
    // Already initialized
    initialized = true;
  }
}
