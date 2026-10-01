/**
 * @jest-environment node
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseSessionCookieParts, safePostLoginPath, signSessionValue } from '../session-cookie';
import { resolveAppUrl } from '../oauth-providers';

function fakeRequest(url: string, headers: Record<string, string> = {}): Request {
  return {
    url,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as Request;
}

async function hmacHex(message: string): Promise<string> {
  const secret = process.env.DAREX_SESSION_SECRET || 'darex-dev-session-secret';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('session cookie format', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const now = Math.floor(Date.now() / 1000);

  it('round-trips userId.epoch.exp.sig', async () => {
    const cookie = await signSessionValue(userId, 3, now + 60);
    expect(cookie.split('.')).toHaveLength(4);
    expect(await parseSessionCookieParts(cookie)).toEqual({
      userId,
      epoch: 3,
      expiresAt: now + 60,
    });
  });

  it('rejects an expired cookie even with a valid signature', async () => {
    const cookie = await signSessionValue(userId, 0, now - 1);
    expect(await parseSessionCookieParts(cookie)).toBeNull();
  });

  it('rejects a tampered epoch or expiry', async () => {
    const cookie = await signSessionValue(userId, 2, now + 60);
    const [u, , exp, sig] = cookie.split('.');
    expect(await parseSessionCookieParts(`${u}.3.${exp}.${sig}`)).toBeNull();
    const [, e] = cookie.split('.');
    expect(await parseSessionCookieParts(`${u}.${e}.${now + 999999}.${sig}`)).toBeNull();
  });

  it('refuses legacy cookies that carry no expiry', async () => {
    const twoPart = `${userId}.${await hmacHex(userId)}`;
    const threePart = `${userId}.0.${await hmacHex(`${userId}.0`)}`;
    expect(await parseSessionCookieParts(twoPart)).toBeNull();
    expect(await parseSessionCookieParts(threePart)).toBeNull();
    expect(await parseSessionCookieParts(userId)).toBeNull();
  });
});

describe('session secret', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.resetModules();
  });

  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  }

  it('refuses a short or missing secret in production and ignores SUPERTOKENS_API_KEY', async () => {
    setEnv({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      DAREX_SESSION_SECRET: 'changeme',
      SUPERTOKENS_API_KEY: 'x'.repeat(64),
    });
    const mod = await import('../session-cookie');
    await expect(mod.signSessionValue('11111111-1111-1111-1111-111111111111', 0, 9e9)).rejects.toThrow(
      /DAREX_SESSION_SECRET/
    );
    setEnv({ DAREX_SESSION_SECRET: undefined });
    await expect(mod.signSessionValue('11111111-1111-1111-1111-111111111111', 0, 9e9)).rejects.toThrow(
      /DAREX_SESSION_SECRET/
    );
  });

  it('accepts a 32+ character secret in production', async () => {
    setEnv({ NODE_ENV: 'production', NEXT_PHASE: undefined, DAREX_SESSION_SECRET: 'k'.repeat(32) });
    const mod = await import('../session-cookie');
    const cookie = await mod.signSessionValue('11111111-1111-1111-1111-111111111111', 1, 9e9);
    expect(cookie.split('.')).toHaveLength(4);
  });
});

/**
 * SEC-A01: every route that mints a session must carry the user's current
 * epoch. Direct applySessionCookies calls are allowed only when they pass
 * sessionEpoch explicitly; everything else goes through issueSessionCookies.
 */
describe('session mint paths', () => {
  const appDir = join(__dirname, '..', '..', 'app');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('never calls applySessionCookies without sessionEpoch', () => {
    const offenders: string[] = [];
    for (const file of walk(appDir)) {
      const src = readFileSync(file, 'utf8');
      const re = /applySessionCookies\(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (!/sessionEpoch/.test(m[1])) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('covers the login, OAuth, SSO, invite and org-create routes', () => {
    const mustMint = [
      'api/auth/[[...path]]/route.ts',
      'api/auth/oauth/callback/[provider]/route.ts',
      'api/auth/sso/callback/[provider]/route.ts',
      'api/auth/invite/[token]/route.ts',
      'api/org/create/route.ts',
    ];
    for (const rel of mustMint) {
      const src = readFileSync(join(appDir, rel), 'utf8');
      expect(/issueSessionCookies\(|applySessionCookies\([^)]*sessionEpoch/.test(src)).toBe(true);
    }
  });

  it('rejects revoked cookies when session_epoch increments (SEC-A02)', async () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const activeEpoch = 2;
    const revokedEpoch = 1;
    const cookieRevoked = await signSessionValue(userId, revokedEpoch, exp);
    const parsedRevoked = await parseSessionCookieParts(cookieRevoked);
    expect(parsedRevoked?.epoch).toBe(revokedEpoch);
    expect(parsedRevoked?.epoch === activeEpoch).toBe(false);

    const cookieActive = await signSessionValue(userId, activeEpoch, exp);
    const parsedActive = await parseSessionCookieParts(cookieActive);
    expect(parsedActive?.epoch).toBe(activeEpoch);
    expect(parsedActive?.epoch === activeEpoch).toBe(true);
  });
});

describe('safePostLoginPath', () => {
  it('allows same-origin relative paths', () => {
    expect(safePostLoginPath('/dashboard')).toBe('/dashboard');
    expect(safePostLoginPath('/ask-ai?x=1')).toBe('/ask-ai?x=1');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safePostLoginPath('//evil.com')).toBe('/');
    expect(safePostLoginPath('https://evil.com')).toBe('/');
    expect(safePostLoginPath('/\\evil.com')).toBe('/');
    expect(safePostLoginPath('javascript:alert(1)')).toBe('/');
    expect(safePostLoginPath(null)).toBe('/');
    expect(safePostLoginPath('')).toBe('/');
  });
});

describe('resolveAppUrl', () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prev;
  });

  it('prefers NEXT_PUBLIC_APP_URL over Host headers', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    const req = fakeRequest('http://localhost:3000/api/auth/oauth/google', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(resolveAppUrl(req)).toBe('https://app.example.com');
  });

  it('ignores X-Forwarded-Host when NEXT_PUBLIC_APP_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const req = fakeRequest('http://localhost:3000/api/auth/oauth/google', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(resolveAppUrl(req)).toBe('http://localhost:3000');
  });
});
