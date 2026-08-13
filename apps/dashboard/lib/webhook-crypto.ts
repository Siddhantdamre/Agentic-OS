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
