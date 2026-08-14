/**
 * Signed session cookies. Safe to import from Next.js Edge middleware
 * (Web Crypto only — no Node or `pg`).
 */

export const SESSION_COOKIE = 'darex_session';
export const ORG_COOKIE = 'darex_org_id';
export const ONBOARDING_COOKIE = 'darex_onboarding';
export const PENDING_INVITE_COOKIE = 'darex_pending_invite';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_REMEMBER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function sessionCookieOptions(maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true as const,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

function sessionSecret(): string {
  const secret = process.env['DAREX_SESSION_SECRET'] || process.env['SUPERTOKENS_API_KEY'];
  const isProd = process.env['NODE_ENV'] === 'production';
  const isNextBuild = process.env['NEXT_PHASE'] === 'phase-production-build';
  if (isProd && !isNextBuild) {
    if (!secret) {
      throw new Error('DAREX_SESSION_SECRET (or SUPERTOKENS_API_KEY) must be set in production');
    }
    return secret;
  }
  return secret || 'darex-dev-session-secret';
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signSessionValue(userId: string): Promise<string> {
  const sig = await hmacSha256Hex(sessionSecret(), userId);
  return `${userId}.${sig}`;
}

/**
 * Returns the Postgres `users.id` from the cookie, or null if missing/invalid.
 * Accepts legacy unsigned UUIDs only outside production so existing local
 * sessions keep working after deploy.
 */
export async function parseSessionCookie(raw: string | undefined | null): Promise<string | null> {
  if (!raw || !raw.trim()) return null;
  const value = raw.trim();
  const lastDot = value.lastIndexOf('.');
  if (lastDot > 0) {
    const userId = value.slice(0, lastDot);
    const sig = value.slice(lastDot + 1);
    if (!UUID_RE.test(userId) || !sig) return null;
    const expected = await hmacSha256Hex(sessionSecret(), userId);
    if (!timingSafeEqualHex(sig, expected)) return null;
    return userId;
  }
  if (process.env.NODE_ENV !== 'production' && UUID_RE.test(value)) {
    return value;
  }
  return null;
}

type CookieWriter = {
  cookies: {
    set: (name: string, value: string, options?: Record<string, unknown>) => void;
    delete: (name: string) => void;
  };
};

export async function applySessionCookies(
  res: CookieWriter,
  opts: {
    userId: string;
    orgId: string;
    onboardingComplete: boolean;
    maxAgeSeconds?: number;
  }
): Promise<void> {
  const maxAge = opts.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const base = sessionCookieOptions(maxAge);
  res.cookies.set(SESSION_COOKIE, await signSessionValue(opts.userId), base);
  res.cookies.set(ORG_COOKIE, opts.orgId, base);
  if (opts.onboardingComplete) {
    res.cookies.delete(ONBOARDING_COOKIE);
  } else {
    res.cookies.set(ONBOARDING_COOKIE, '1', base);
  }
}

export function clearSessionCookies(res: CookieWriter): void {
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(ORG_COOKIE);
  res.cookies.delete(ONBOARDING_COOKIE);
  res.cookies.delete(PENDING_INVITE_COOKIE);
}

export function isPublicAuthPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/register' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/register/') ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/forgot-password/') ||
    pathname.startsWith('/reset-password/')
  );
}

/** Pages a signed-in user may still visit (invite accept, password reset). */
export function isAuthenticatedPublicPath(pathname: string): boolean {
  return pathname.startsWith('/invite/') || pathname.startsWith('/reset-password');
}

export function isPublicApiPath(pathname: string): boolean {
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/webhooks/')) return true;
  // H6 public chat widget — tenant is the embed site key, not a session cookie.
  if (pathname.startsWith('/api/widget')) return true;
  if (!pathname.startsWith('/api/auth/')) return false;
  if (pathname === '/api/auth/session') return true;
  if (pathname === '/api/auth/logout' || pathname === '/api/auth/signout') return true;
  if (pathname === '/api/auth/login' || pathname === '/api/auth/signin') return true;
  if (pathname === '/api/auth/signup' || pathname === '/api/auth/register') return true;
  if (pathname === '/api/auth/forgot-password' || pathname === '/api/auth/reset-password') return true;
  if (pathname.startsWith('/api/auth/oauth/')) return true;
  if (pathname.startsWith('/api/auth/sso')) return true;
  if (pathname.startsWith('/api/auth/invite/')) return true;
  return false;
}
