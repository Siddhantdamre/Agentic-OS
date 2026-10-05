/**
 * Signed session cookies. Safe to import from Next.js Edge middleware
 * (Web Crypto only — no Node or `pg`).
 *
 * Cookie format: `userId.epoch.exp.sig`. HMAC covers `userId.epoch.exp`;
 * `exp` is unix seconds and is enforced here, so a leaked cookie stops working
 * even if the browser ignores Max-Age. `epoch` must match users.session_epoch
 * (checked server-side by getScopedClient / verifySessionEpoch). Older
 * `userId.sig` and `userId.epoch.sig` cookies carry no expiry and are refused.
 */

export const SESSION_COOKIE = 'darex_session';
export const ORG_COOKIE = 'darex_org_id';
export const ONBOARDING_COOKIE = 'darex_onboarding';
export const PENDING_INVITE_COOKIE = 'darex_pending_invite';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_REMEMBER_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type ParsedSessionCookie = {
  userId: string;
  /** Must match users.session_epoch. */
  epoch: number;
  /** Unix seconds after which the cookie is rejected. */
  expiresAt: number;
};

/** Production requires a dedicated secret of at least this many characters. */
export const MIN_SESSION_SECRET_LENGTH = 32;

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
  const secret = process.env['DAREX_SESSION_SECRET'];
  const isProd = process.env['NODE_ENV'] === 'production';
  const isNextBuild = process.env['NEXT_PHASE'] === 'phase-production-build';
  if (isProd && !isNextBuild) {
    // Dedicated key only: sharing SUPERTOKENS_API_KEY meant anyone holding the
    // auth-core key could forge sessions.
    if (!secret || secret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `DAREX_SESSION_SECRET must be set to at least ${MIN_SESSION_SECRET_LENGTH} characters in production`
      );
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

/** Signs `userId.epoch.exp`. `expiresAt` is unix seconds. */
export async function signSessionValue(
  userId: string,
  epoch: number,
  expiresAt: number
): Promise<string> {
  const epochNum = Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : 0;
  const exp = Math.floor(expiresAt);
  const payload = `${userId}.${epochNum}.${exp}`;
  const sig = await hmacSha256Hex(sessionSecret(), payload);
  return `${payload}.${sig}`;
}

/**
 * Full parse: user id + session epoch + expiry. Returns null if missing,
 * malformed, tampered or expired. Does not check the epoch against the DB.
 */
export async function parseSessionCookieParts(
  raw: string | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<ParsedSessionCookie | null> {
  if (!raw || !raw.trim()) return null;
  const parts = raw.trim().split('.');
  if (parts.length !== 4) return null;
  const [userId, epochStr, expStr, sig] = parts;
  if (!UUID_RE.test(userId) || !sig) return null;
  if (!/^\d+$/.test(epochStr) || !/^\d+$/.test(expStr)) return null;
  const epoch = Number.parseInt(epochStr, 10);
  const expiresAt = Number.parseInt(expStr, 10);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(expiresAt)) return null;
  const expected = await hmacSha256Hex(sessionSecret(), `${userId}.${epoch}.${expiresAt}`);
  if (!timingSafeEqualHex(sig, expected)) return null;
  if (expiresAt <= nowSeconds) return null;
  return { userId, epoch, expiresAt };
}

/**
 * Returns the user id from a validly signed, unexpired cookie. Does NOT check
 * users.session_epoch — anything that authorizes an action must use
 * getScopedClient() or verifySessionEpoch() instead.
 */
export async function parseSessionCookie(raw: string | undefined | null): Promise<string | null> {
  const parsed = await parseSessionCookieParts(raw);
  return parsed?.userId ?? null;
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
    /**
     * Current users.session_epoch. Required: a stale epoch (e.g. 0 after a
     * revoke) produces a cookie getScopedClient rejects on every request.
     * Route handlers should use issueSessionCookies() from session-epoch.ts,
     * which reads it for them.
     */
    sessionEpoch: number;
  }
): Promise<void> {
  const maxAge = opts.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const base = sessionCookieOptions(maxAge);
  const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
  res.cookies.set(
    SESSION_COOKIE,
    await signSessionValue(opts.userId, opts.sessionEpoch, expiresAt),
    base
  );
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
    pathname === '/verify-email' ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/register/') ||
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/forgot-password/') ||
    pathname.startsWith('/reset-password/')
  );
}

/** Pages a signed-in user may still visit (invite accept, password reset). */
export function isAuthenticatedPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/invite/') ||
    pathname.startsWith('/reset-password') ||
    pathname === '/verify-email'
  );
}

/**
 * Post-login redirect from ?redirect=. Rejects protocol-relative URLs
 * (`//evil.com`), backslash tricks, and absolute URLs. Same-origin path only.
 */
export function safePostLoginPath(redirect: string | null | undefined): string {
  if (!redirect || typeof redirect !== 'string') return '/';
  const path = redirect.trim();
  if (!path.startsWith('/')) return '/';
  if (path.startsWith('//') || path.startsWith('/\\')) return '/';
  if (path.includes('://') || path.includes('\\')) return '/';
  return path;
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
  if (pathname === '/api/auth/verify-email' || pathname === '/api/auth/resend-verification') return true;
  if (pathname === '/api/auth/oauth' || pathname.startsWith('/api/auth/oauth/')) return true;
  if (pathname.startsWith('/api/auth/sso')) return true;
  if (pathname.startsWith('/api/auth/invite/')) return true;
  return false;
}
