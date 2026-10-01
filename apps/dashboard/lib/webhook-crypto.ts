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

/** Constant-time string compare for shared secrets / bearer tokens. */
export function secretEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqualString(provided, expected);
}

/** Accept primary or previous secret during rotation windows. */
function secretsFromEnv(...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) out.push(value);
  }
  return out;
}

function verifyHmacSha256Hex(rawBody: string, signatureHeader: string | null, secrets: string[]): boolean {
  if (!signatureHeader || secrets.length === 0) return false;
  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  for (const secret of secrets) {
    const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (timingSafeEqualString(provided.toLowerCase(), expectedHex.toLowerCase())) return true;
  }
  return false;
}

/** Chatwoot / Darex inbox HMAC: `x-chatwoot-signature: sha256=<hex>`. */
export function verifyChatwootSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  return verifyHmacSha256Hex(rawBody, signatureHeader, [secret]);
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

function metaAppSecrets(): string[] {
  return secretsFromEnv(
    'WHATSAPP_APP_SECRET',
    'META_APP_SECRET',
    'WHATSAPP_APP_SECRET_PREVIOUS',
    'META_APP_SECRET_PREVIOUS'
  );
}

/**
 * Production always requires a valid Meta signature when a secret is configured.
 * Local/dev without a secret (or unsigned e2e) is allowed so Meta console setup
 * is not a blocker for ingest tests - unsigned traffic is rejected in production.
 * Dual-secret: WHATSAPP_APP_SECRET_PREVIOUS / META_APP_SECRET_PREVIOUS accepted during rotation.
 */
export function assertMetaWebhookSignature(rawBody: string, signatureHeader: string | null): { ok: boolean; status: number; error?: string } {
  const secrets = metaAppSecrets();
  const isProd = process.env.NODE_ENV === 'production';

  if (secrets.length === 0) {
    if (isProd) {
      return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
    }
    console.warn('[WhatsApp Webhook] META_APP_SECRET unset - skipping signature check (non-production)');
    return { ok: true, status: 200 };
  }

  if (!verifyHmacSha256Hex(rawBody, signatureHeader, secrets)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

export function assertChatwootWebhookSignature(rawBody: string, signatureHeader: string | null): { ok: boolean; status: number; error?: string } {
  const secrets = secretsFromEnv('CHATWOOT_WEBHOOK_SECRET', 'CHATWOOT_WEBHOOK_SECRET_PREVIOUS');
  if (secrets.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
    }
    console.warn('[Chatwoot Webhook] CHATWOOT_WEBHOOK_SECRET unset - skipping signature check (non-production)');
    return { ok: true, status: 200 };
  }
  if (!verifyHmacSha256Hex(rawBody, signatureHeader, secrets)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

export type WebhookSigResult = { ok: boolean; status: number; error?: string };

function unsignedAllowed(label: string): WebhookSigResult {
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, status: 401, error: 'Webhook signature secret is not configured' };
  }
  console.warn(`[${label}] signature secret unset - skipping signature check (non-production)`);
  return { ok: true, status: 200 };
}

/**
 * Nango webhooks: `X-Nango-Signature` is HMAC-SHA256 (hex) of the raw POST
 * body keyed with the Nango webhook secret (Nango dashboard -> webhooks).
 */
export function verifyNangoSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  return verifyHmacSha256Hex(rawBody, signatureHeader, [secret]);
}

/** Unlike provider webhooks, the Nango receiver is opt-in: no secret means
 *  Nango webhooks must NOT be enabled in the Nango UI, so refuse outright in
 *  every environment (not just production). */
export function assertNangoWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): WebhookSigResult {
  const secrets = secretsFromEnv('NANGO_WEBHOOK_SECRET', 'NANGO_WEBHOOK_SECRET_PREVIOUS');
  if (secrets.length === 0) {
    return { ok: false, status: 503, error: 'Nango webhooks are not configured (set NANGO_WEBHOOK_SECRET)' };
  }
  if (!verifyHmacSha256Hex(rawBody, signatureHeader, secrets)) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}
/**
 * Twilio `X-Twilio-Signature` - HMAC-SHA1 of the public URL + sorted POST params,
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
  const tokens = secretsFromEnv('TWILIO_AUTH_TOKEN', 'TWILIO_AUTH_TOKEN_PREVIOUS');
  if (tokens.length === 0) {
    return unsignedAllowed('SMS Webhook');
  }
  const params = parseFormBody(rawBody);
  const url = twilioWebhookUrl(requestUrl);
  for (const token of tokens) {
    if (verifyTwilioSignature(token, url, params, signatureHeader)) {
      return { ok: true, status: 200 };
    }
  }
  return { ok: false, status: 401, error: 'Invalid webhook signature' };
}

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwksCache: { keys: JsonWebKey[]; fetchedAt: number } | null = null;

type JsonWebKey = {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
};

async function loadGoogleJwks(): Promise<JsonWebKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const res = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google JWKS HTTP ${res.status}`);
  const data = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

function base64UrlToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function jwkToPem(jwk: JsonWebKey): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
}

/**
 * Verify Google Cloud Pub/Sub push OIDC JWT (Authorization: Bearer).
 * Audience must match GMAIL_PUSH_AUDIENCE or the request URL origin+path.
 */
export async function verifyGooglePubSubOidcJwt(
  authHeader: string | null,
  expectedAudience: string
): Promise<{ ok: boolean; email?: string; error?: string }> {
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, error: 'Missing Bearer token' };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Malformed JWT' };
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { kid?: string; alg?: string };
  let payload: {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    email?: string;
    email_verified?: boolean | string;
  };
  try {
    header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, error: 'Invalid JWT JSON' };
  }
  if (header.alg !== 'RS256') return { ok: false, error: 'Unsupported JWT alg' };
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    return { ok: false, error: 'Invalid JWT issuer' };
  }
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAudience)
    : payload.aud === expectedAudience;
  if (!audOk) return { ok: false, error: 'Invalid JWT audience' };
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() - 60_000) {
    return { ok: false, error: 'JWT expired' };
  }
  try {
    const keys = await loadGoogleJwks();
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) return { ok: false, error: 'No Google JWKS key' };
    const key = jwkToPem(jwk);
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      base64UrlToBuffer(sigB64)
    );
    if (!verified) return { ok: false, error: 'Invalid JWT signature' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JWT verify failed: ${message}` };
  }
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (payload.email && !emailVerified) {
    return { ok: false, error: 'JWT email not verified' };
  }
  return { ok: true, email: payload.email };
}

/**
 * Gmail Pub/Sub push auth.
 * Prefer Google OIDC JWT in Authorization: Bearer (cryptographic).
 * Fallback: shared GMAIL_PUSH_TOKEN / ?token= (legacy) when JWT absent and token configured.
 * Production requires at least one of JWT success or shared token.
 */
export async function assertGmailPushToken(
  request: Request,
  rawBody: string
): Promise<WebhookSigResult> {
  void rawBody;
  const auth = request.headers.get('authorization') || '';
  const audience =
    process.env.GMAIL_PUSH_AUDIENCE?.trim() ||
    (() => {
      try {
        const u = new URL(request.url);
        return `${u.origin}${u.pathname}`;
      } catch {
        return '';
      }
    })();

  if (auth.toLowerCase().startsWith('bearer ') && audience) {
    const jwt = await verifyGooglePubSubOidcJwt(auth, audience);
    if (jwt.ok) return { ok: true, status: 200 };
    // Fall through to shared token for rotation / dual-mode
    console.warn('[Gmail Push] OIDC JWT rejected:', jwt.error);
  }

  const expectedTokens = secretsFromEnv(
    'GMAIL_PUSH_TOKEN',
    'GMAIL_PUBSUB_VERIFICATION_TOKEN',
    'GMAIL_PUSH_TOKEN_PREVIOUS',
    'GMAIL_PUBSUB_VERIFICATION_TOKEN_PREVIOUS'
  );
  if (expectedTokens.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, status: 401, error: 'Gmail push requires OIDC JWT or GMAIL_PUSH_TOKEN' };
    }
    return unsignedAllowed('Gmail Push');
  }
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const urlToken = new URL(request.url).searchParams.get('token') || '';
  const provided = bearer || urlToken;
  // Shared token must not look like a JWT (three segments) when OIDC failed
  if (provided.includes('.') && provided.split('.').length === 3) {
    return { ok: false, status: 401, error: 'Invalid Google Pub/Sub OIDC JWT' };
  }
  if (!provided || !expectedTokens.some((t) => timingSafeEqualString(provided, t))) {
    return { ok: false, status: 401, error: 'Invalid webhook signature' };
  }
  return { ok: true, status: 200 };
}

/** Reject oversized webhook bodies before parse (DoS guard). Default 1 MiB. */
export function assertWebhookBodySize(
  request: Request,
  rawBody: string,
  maxBytes = Number(process.env.WEBHOOK_MAX_BODY_BYTES || 1_048_576)
): WebhookSigResult {
  const headerLen = Number(request.headers.get('content-length') || 0);
  const size = Math.max(headerLen, Buffer.byteLength(rawBody, 'utf8'));
  if (size > maxBytes) {
    return { ok: false, status: 413, error: `Webhook body exceeds ${maxBytes} bytes` };
  }
  return { ok: true, status: 200 };
}

/**
 * Evolution API (QR WhatsApp) webhooks carry `x-darex-webhook-secret`, set
 * per instance when we create it. Opt-in like Nango: no secret configured
 * means refuse in every environment, since the transport is unofficial and
 * unsigned traffic would let anyone inject customer messages.
 */
export function assertEvolutionWebhookSecret(headerValue: string | null): WebhookSigResult {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return { ok: false, status: 503, error: 'Evolution webhooks are not configured (set EVOLUTION_WEBHOOK_SECRET)' };
  }
  if (!headerValue || !secretEquals(headerValue, secret)) {
    return { ok: false, status: 401, error: 'Invalid webhook secret' };
  }
  return { ok: true, status: 200 };
}
