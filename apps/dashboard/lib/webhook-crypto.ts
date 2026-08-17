import crypto from 'crypto';

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Chatwoot / Darex inbox HMAC: `x-chatwoot-signature: sha256=<hex>`. */
export function verifyChatwootSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  return timingSafeEqualString(provided.toLowerCase(), expectedHex.toLowerCase());
}

export function signChatwootBody(rawBody: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

/**
 * Meta Cloud API `X-Hub-Signature-256: sha256=<hex>` over the raw POST body
 * using the app secret (`META_APP_SECRET` / `WHATSAPP_APP_SECRET`).
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return timingSafeEqualString(signatureHeader, expected);
}

export function metaAppSecret(): string | null {
  return process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET || null;
}

/**
 * Production always requires a valid Meta signature when a secret is configured.
 * Local/dev without a secret (or unsigned e2e) is allowed so Meta console setup
 * is not a blocker for ingest tests — unsigned traffic is rejected in production.
 */
export function assertMetaWebhookSignature(rawBody: string, signatureHeader: string | null): { ok: boolean; status: number; error?: string } {
  const secret = metaAppSecret();
  const isProd = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (isProd) {
      return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
    }
    console.warn('[WhatsApp Webhook] META_APP_SECRET unset — skipping signature check (non-production)');
    return { ok: true, status: 200 };
  }

  if (!verifyMetaSignature(rawBody, signatureHeader, secret)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

export function assertChatwootWebhookSignature(rawBody: string, signatureHeader: string | null): { ok: boolean; status: number; error?: string } {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
    }
    console.warn('[Chatwoot Webhook] CHATWOOT_WEBHOOK_SECRET unset — skipping signature check (non-production)');
    return { ok: true, status: 200 };
  }
  if (!verifyChatwootSignature(rawBody, signatureHeader, secret)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

export type WebhookSigResult = { ok: boolean; status: number; error?: string };

function unsignedAllowed(label: string): WebhookSigResult {
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
  }
  console.warn(`[${label}] signature secret unset — skipping signature check (non-production)`);
  return { ok: true, status: 200 };
}

/**
 * Twilio `X-Twilio-Signature` — HMAC-SHA1 of the public URL + sorted POST params,
 * Base64, using TWILIO_AUTH_TOKEN. See https://www.twilio.com/docs/usage/security
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader) return false;
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) {
    data += key + params[key];
  }
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  return timingSafeEqualString(signatureHeader, expected);
}

export function parseFormBody(rawBody: string): Record<string, string> {
  const params = new URLSearchParams(rawBody);
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function twilioWebhookUrl(requestUrl: string): string {
  const configured = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (configured) return configured;
  const publicBase = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (publicBase) return `${publicBase}/api/webhooks/sms`;
  return requestUrl.split('?')[0];
}

export function assertTwilioWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  requestUrl: string
): WebhookSigResult {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    return unsignedAllowed('SMS Webhook');
  }
  const params = parseFormBody(rawBody);
  const url = twilioWebhookUrl(requestUrl);
  if (!verifyTwilioSignature(token, url, params, signatureHeader)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

/**
 * Gmail Pub/Sub push. Require `Authorization: Bearer <GMAIL_PUSH_TOKEN>` or
 * `?token=` matching GMAIL_PUSH_TOKEN. Production always requires it.
 */
export function assertGmailPushToken(
  request: Request,
  rawBody: string
): WebhookSigResult {
  void rawBody;
  const expected = process.env.GMAIL_PUSH_TOKEN?.trim() || process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN?.trim() || '';
  if (!expected) {
    return unsignedAllowed('Gmail Push');
  }
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const urlToken = new URL(request.url).searchParams.get('token') || '';
  const provided = bearer || urlToken;
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}
