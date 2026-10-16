/**
 * @jest-environment node
 */

const epochs = new Map<string, number>();
const disabledUsers = new Set<string>();

jest.mock('@/lib/db', () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, params: unknown[]) => {
        if (/set_config/.test(sql)) return { rows: [] };
        const id = String(params[0]);
        return epochs.has(id)
          ? { rows: [{ session_epoch: epochs.get(id), disabled: disabledUsers.has(id) }] }
          : { rows: [] };
      },
      release: () => {},
    }),
  },
}));

import { issueSessionCookies, verifySessionCookie } from '../session-epoch';
import { parseSessionCookieParts, SESSION_COOKIE } from '../session-cookie';

const userId = '22222222-2222-2222-2222-222222222222';

function capture() {
  const jar = new Map<string, string>();
  return {
    jar,
    res: {
      cookies: {
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      },
    },
  };
}

describe('issueSessionCookies (SEC-A01)', () => {
  it('mints at the current users.session_epoch, not 0', async () => {
    epochs.set(userId, 5);
    const { jar, res } = capture();
    await issueSessionCookies(res, { userId, orgId: 'o', onboardingComplete: true });
    const parsed = await parseSessionCookieParts(jar.get(SESSION_COOKIE));
    expect(parsed?.epoch).toBe(5);
  });

  it('refuses to mint for a user row that does not exist', async () => {
    const { res } = capture();
    await expect(
      issueSessionCookies(res, {
        userId: '33333333-3333-3333-3333-333333333333',
        orgId: 'o',
        onboardingComplete: true,
      })
    ).rejects.toThrow('Unauthorized');
  });
});

describe('verifySessionCookie (SEC-A02)', () => {
  it('accepts a cookie at the current epoch and rejects it after a revoke', async () => {
    epochs.set(userId, 1);
    const { jar, res } = capture();
    await issueSessionCookies(res, { userId, orgId: 'o', onboardingComplete: true });
    const raw = jar.get(SESSION_COOKIE);
    expect((await verifySessionCookie(raw))?.userId).toBe(userId);

    epochs.set(userId, 2); // revoke-sessions bumps the epoch
    expect(await verifySessionCookie(raw)).toBeNull();

    // A fresh login after the revoke works again (the old permanent lockout).
    const again = capture();
    await issueSessionCookies(again.res, { userId, orgId: 'o', onboardingComplete: true });
    expect((await verifySessionCookie(again.jar.get(SESSION_COOKIE)))?.userId).toBe(userId);
  });
});

describe('disabled users (platform console)', () => {
  it('cannot mint a cookie, and an old cookie stops verifying', async () => {
    epochs.set(userId, 1);
    const { jar, res } = capture();
    await issueSessionCookies(res, { userId, orgId: 'o', onboardingComplete: true });
    const raw = jar.get(SESSION_COOKIE);
    expect((await verifySessionCookie(raw))?.userId).toBe(userId);

    disabledUsers.add(userId);
    expect(await verifySessionCookie(raw)).toBeNull();
    await expect(issueSessionCookies(capture().res, { userId, orgId: 'o', onboardingComplete: true })).rejects.toThrow('Unauthorized');

    disabledUsers.delete(userId); // re-enabled
    await expect(issueSessionCookies(capture().res, { userId, orgId: 'o', onboardingComplete: true })).resolves.toBeUndefined();
  });
});
