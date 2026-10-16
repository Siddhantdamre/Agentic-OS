/**
 * Browser half of Meta Embedded Signup: load the Facebook SDK, open the login
 * with our config, and resolve with the one-time code plus the WABA and phone
 * ids Meta reports. The server re-verifies all of it (never trust these ids).
 */

const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || '';
const CONFIG_ID = process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || '';

export const embeddedSignupAvailable = Boolean(APP_ID && CONFIG_ID);

export type SignupResult = { code: string; wabaId: string; phoneNumberId: string };

declare global {
  interface Window {
    FB?: {
      init(opts: Record<string, unknown>): void;
      login(cb: (r: { authResponse?: { code?: string } | null }) => void, opts: Record<string, unknown>): void;
    };
  }
}

function loadSdk(): Promise<void> {
  if (window.FB) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.onload = () => {
      window.FB?.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
      resolve();
    };
    s.onerror = () => reject(new Error('Could not load the Facebook SDK'));
    document.head.appendChild(s);
  });
}

export async function startEmbeddedSignup(): Promise<SignupResult> {
  if (!embeddedSignupAvailable) throw new Error('Facebook signup is not configured');
  await loadSdk();
  return new Promise((resolve, reject) => {
    let ids: { wabaId: string; phoneNumberId: string } | null = null;
    let code: string | null = null;
    const finish = () => {
      if (!ids || !code) return;
      window.removeEventListener('message', onMessage);
      resolve({ code, ...ids });
    };
    // Meta posts the chosen WABA and phone number id from its own origin only.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== 'https://www.facebook.com' && e.origin !== 'https://web.facebook.com') return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'FINISH' && data.data?.waba_id && data.data?.phone_number_id) {
          ids = { wabaId: String(data.data.waba_id), phoneNumberId: String(data.data.phone_number_id) };
          finish();
        } else if (data.event === 'CANCEL') {
          window.removeEventListener('message', onMessage);
          reject(new Error('Signup cancelled'));
        }
      } catch {
        /* not our message */
      }
    };
    window.addEventListener('message', onMessage);
    window.FB!.login(
      (r) => {
        if (r.authResponse?.code) {
          code = r.authResponse.code;
          finish();
        } else {
          window.removeEventListener('message', onMessage);
          reject(new Error('Facebook login was cancelled'));
        }
      },
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      }
    );
  });
}
