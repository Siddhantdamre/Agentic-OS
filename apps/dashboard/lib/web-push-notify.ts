import { getOrgScopedClient } from '@/lib/db';
import { createSign } from 'crypto';

/**
 * Web Push delivery for needs_attention.
 * Honest no-op when VAPID keys are missing — never invents a delivered notification.
 */

type PushSub = { endpoint: string; p256dh: string; auth: string };

let warnedMissingVapid = false;

function vapidKeys(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() || '';
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT?.trim() || 'mailto:ops@darex.local',
  };
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Minimal ES256 VAPID JWT for the audience origin of the push endpoint. */
function buildVapidJwt(
  audience: string,
  subject: string,
  privateKeyPem: string
): string | null {
  try {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const payload = b64url(JSON.stringify({ aud: audience, exp, sub: subject }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('SHA256');
    signer.update(signingInput);
    signer.end();
    const key = privateKeyPem.includes('BEGIN')
      ? privateKeyPem
      : `-----BEGIN PRIVATE KEY-----\n${privateKeyPem}\n-----END PRIVATE KEY-----`;
    const sig = signer.sign(key);
    return `${signingInput}.${b64url(sig)}`;
  } catch (err) {
    console.error('[web-push] VAPID JWT sign failed:', err);
    return null;
  }
}

async function loadSubs(orgId: string): Promise<PushSub[]> {
  try {
    const { client } = await getOrgScopedClient(orgId);
    try {
      const res = await client.query<PushSub>(
        `SELECT endpoint, p256dh, auth FROM web_push_subscriptions WHERE org_id = $1::uuid LIMIT 200`,
        [orgId]
      );
      return res.rows;
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/web_push_subscriptions|relation .* does not exist/i.test(message)) return [];
    console.error('[web-push] loadSubs failed:', message);
    return [];
  }
}

/**
 * Attempt Web Push for a needs_attention event.
 * Returns how many endpoints accepted; 0 when VAPID unset (honest skip).
 */
export async function notifyNeedsAttentionPush(
  orgId: string,
  payload: { conversationId?: string; message?: string }
): Promise<{ attempted: number; accepted: number; skippedReason?: string }> {
  const keys = vapidKeys();
  if (!keys) {
    if (!warnedMissingVapid) {
      warnedMissingVapid = true;
      console.info(
        '[web-push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY unset — subscriptions stored but not delivered'
      );
    }
    return { attempted: 0, accepted: 0, skippedReason: 'vapid_not_configured' };
  }

  const subs = await loadSubs(orgId);
  if (subs.length === 0) return { attempted: 0, accepted: 0, skippedReason: 'no_subscriptions' };

  const body = JSON.stringify({
    title: 'Needs attention',
    body: payload.message?.slice(0, 200) || 'A conversation needs attention',
    conversationId: payload.conversationId,
  });

  let accepted = 0;
  for (const sub of subs) {
    let audience: string;
    try {
      audience = new URL(sub.endpoint).origin;
    } catch {
      continue;
    }
    const jwt = buildVapidJwt(audience, keys.subject, keys.privateKey);
    if (!jwt) continue;
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: '60',
          Urgency: 'high',
          Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok || res.status === 201) accepted += 1;
      else if (res.status === 404 || res.status === 410) {
        console.warn(`[web-push] endpoint gone (${res.status}): ${sub.endpoint.slice(0, 80)}`);
      } else {
        console.warn(`[web-push] push endpoint returned ${res.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[web-push] delivery error:', message);
    }
  }
  return { attempted: subs.length, accepted };
}
