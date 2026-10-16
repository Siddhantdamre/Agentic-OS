import { fetchWithTimeout } from '../http.js';

/**
 * Meta Embedded Signup, server half. The browser runs the Facebook login and
 * hands us a one-time `code` plus the WABA and phone ids it claims. We do not
 * trust those ids: the token we get for the code must itself be able to list
 * the WABA's phone numbers, and that list must contain the phone id.
 *
 * Needs a Meta app with WhatsApp and Embedded Signup enabled (app id, app
 * secret, config id). Not exercised against Meta in this repo: no credentials.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export type SignupInput = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  appId: string;
  appSecret: string;
};

export type SignupResult =
  | { ok: true; accessToken: string; wabaId: string; phoneNumberId: string; webhookSubscribed: boolean }
  | { ok: false; status: number; message: string };

const ID = /^\d{5,30}$/;

async function graph(path: string, token: string | null, init?: RequestInit) {
  const res = await fetchWithTimeout(
    `${GRAPH}${path}`,
    { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } },
    15000
  );
  const json = (await res.json().catch(() => null)) as any;
  return { ok: res.ok, status: res.status, json };
}

export async function completeEmbeddedSignup(input: SignupInput): Promise<SignupResult> {
  const { code, wabaId, phoneNumberId, appId, appSecret } = input;
  if (!code || !ID.test(wabaId) || !ID.test(phoneNumberId)) {
    return { ok: false, status: 400, message: 'The Facebook signup did not return a code, WABA id and phone number id.' };
  }
  try {
    const q = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
    const tok = await graph(`/oauth/access_token?${q.toString()}`, null);
    const accessToken = tok.json?.access_token;
    if (!tok.ok || typeof accessToken !== 'string') {
      return { ok: false, status: 400, message: `Meta refused the signup code: ${tok.json?.error?.message || tok.status}` };
    }

    const numbers = await graph(`/${wabaId}/phone_numbers?fields=id`, accessToken);
    const listed: string[] = Array.isArray(numbers.json?.data) ? numbers.json.data.map((n: { id?: string }) => String(n.id)) : [];
    if (!numbers.ok || !listed.includes(phoneNumberId)) {
      return { ok: false, status: 403, message: 'That phone number does not belong to the WhatsApp account you signed in with.' };
    }

    // Deliver inbound webhooks for this WABA to our app. Failure is reported, not hidden.
    const sub = await graph(`/${wabaId}/subscribed_apps`, accessToken, { method: 'POST', body: '{}' });
    return { ok: true, accessToken, wabaId, phoneNumberId, webhookSubscribed: sub.ok && sub.json?.success !== false };
  } catch (err: unknown) {
    return { ok: false, status: 502, message: `Meta signup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
