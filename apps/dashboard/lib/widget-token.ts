import crypto from 'crypto';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function widgetSessionSecret(): string {
  const secret = process.env.WIDGET_SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WIDGET_SESSION_SECRET is required in production');
  }
  return 'darex-widget-dev-session-secret';
}

function widgetSessionSecrets(): string[] {
  const current = process.env.WIDGET_SESSION_SECRET?.trim();
  const previous = process.env.WIDGET_SESSION_SECRET_PREVIOUS?.trim();
  if (current) return previous ? [current, previous] : [current];
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WIDGET_SESSION_SECRET is required in production');
  }
  return ['darex-widget-dev-session-secret'];
}

export type VisitorTokenPayload = {
  orgId: string;
  sessionId: string;
  visitorId: string;
  expiresAt: number;
};

export function signVisitorSession(
  orgId: string,
  sessionId: string,
  visitorId?: string,
  ttlMs = DEFAULT_TTL_MS
): string {
  const payload: VisitorTokenPayload = {
    orgId,
    sessionId,
    visitorId: visitorId || sessionId,
    expiresAt: Date.now() + ttlMs,
  };
  const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', widgetSessionSecret()).update(serialized).digest('base64url');
  return `${serialized}.${hmac}`;
}

export function verifyVisitorSession(
  token: string | null | undefined,
  orgId: string,
  sessionId: string
): boolean {
  if (!token || !token.includes('.')) return false;
  try {
    const [payloadB64, hmac] = token.split('.');
    if (!payloadB64 || !hmac) return false;
    const secrets = widgetSessionSecrets();
    const hmacBuf = Buffer.from(hmac);
    const matched = secrets.some((secret) => {
      const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
      const expBuf = Buffer.from(expected);
      return hmacBuf.length === expBuf.length && crypto.timingSafeEqual(hmacBuf, expBuf);
    });
    if (!matched) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as VisitorTokenPayload;
    if (payload.orgId !== orgId || payload.sessionId !== sessionId) return false;
    if (Date.now() > payload.expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}

export function extractVisitorToken(request: Request): string | null {
  const header = request.headers.get('x-visitor-token') || request.headers.get('X-Visitor-Token');
  if (header?.trim()) return header.trim();
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('visitorToken') || url.searchParams.get('vt');
    return q?.trim() || null;
  } catch {
    return null;
  }
}
