import type { PoolClient } from 'pg';
import {
  consumeVerificationToken,
  emailVerificationRequired,
  isEmailVerified,
} from '../email-verification';
import { isPublicApiPath, isPublicAuthPath } from '../session-cookie';

function fakeClient(impl: (sql: string, params?: unknown[]) => Promise<unknown>): PoolClient {
  return { query: impl } as unknown as PoolClient;
}

describe('email verification', () => {
  const prev = process.env.REQUIRE_EMAIL_VERIFICATION;
  afterEach(() => {
    if (prev === undefined) delete process.env.REQUIRE_EMAIL_VERIFICATION;
    else process.env.REQUIRE_EMAIL_VERIFICATION = prev;
  });

  it('enforces only when REQUIRE_EMAIL_VERIFICATION is exactly "true"', () => {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
    expect(emailVerificationRequired()).toBe(false);
    process.env.REQUIRE_EMAIL_VERIFICATION = '1';
    expect(emailVerificationRequired()).toBe(false);
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    expect(emailVerificationRequired()).toBe(true);
  });

  it('reports unverified users as unverified', async () => {
    const c = fakeClient(async () => ({ rows: [{ v: false }] }));
    expect(await isEmailVerified(c, 'u1')).toBe(false);
  });

  it('degrades to verified before the migration exists, rethrows other errors', async () => {
    const missing = fakeClient(async () => {
      throw Object.assign(new Error('no fn'), { code: '42883' });
    });
    expect(await isEmailVerified(missing, 'u1')).toBe(true);
    const broken = fakeClient(async () => {
      throw Object.assign(new Error('boom'), { code: '08006' });
    });
    await expect(isEmailVerified(broken, 'u1')).rejects.toThrow('boom');
  });

  it('hashes the token before the lookup and maps bad tokens to ok:false', async () => {
    const seen: unknown[][] = [];
    const good = fakeClient(async (_s, p) => {
      seen.push(p ?? []);
      return { rows: [{ id: 'user-1' }] };
    });
    expect(await consumeVerificationToken(good, 'raw-token')).toEqual({ ok: true, userId: 'user-1' });
    expect(seen[0][0]).not.toBe('raw-token');
    expect(String(seen[0][0])).toMatch(/^[0-9a-f]{64}$/);

    for (const code of ['VERIFY_NOT_FOUND', 'VERIFY_EXPIRED', 'VERIFY_ALREADY_USED']) {
      const bad = fakeClient(async () => {
        throw new Error(code);
      });
      expect(await consumeVerificationToken(bad, 't')).toEqual({ ok: false });
    }
  });

  it('exposes the verify routes and page to signed-out visitors', () => {
    expect(isPublicApiPath('/api/auth/verify-email')).toBe(true);
    expect(isPublicApiPath('/api/auth/resend-verification')).toBe(true);
    expect(isPublicAuthPath('/verify-email')).toBe(true);
  });
});
