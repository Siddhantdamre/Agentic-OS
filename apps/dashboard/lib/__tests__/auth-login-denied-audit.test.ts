/**
 * @jest-environment node
 *
 * Failed and locked logins leave a denied `login` audit row (audit-log #3).
 */
import { POST } from '@/app/api/auth/[[...path]]/route';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';

const audit = jest.fn(async (_p: unknown) => undefined);
let locked = false;

jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: (p: unknown) => audit(p) }));
jest.mock('@/lib/supertokens', () => ({ ensureSuperTokensInit: jest.fn() }));
jest.mock('supertokens-node/recipe/emailpassword', () => ({
  __esModule: true,
  default: { signIn: jest.fn(async () => ({ status: 'WRONG_CREDENTIALS_ERROR' })) },
}));
jest.mock('@/lib/db', () => ({
  pool: { connect: jest.fn(async () => ({ query: jest.fn(), release: jest.fn() })) },
  createOrgForEmail: jest.fn(),
  ensureUserOrg: jest.fn(),
}));
jest.mock('@/lib/rate-limit', () => ({
  clientIpFromRequest: () => '127.0.0.1',
  denyAuthIfLimited: () => null,
}));
jest.mock('@/lib/auth-user', () => ({
  acceptInviteToken: jest.fn(),
  insertAuthUser: jest.fn(),
  isOnboardingComplete: jest.fn(),
  linkSuperTokensId: jest.fn(),
  lookupInviteByToken: jest.fn(),
  lookupUserByEmail: jest.fn(async () => ({
    id: USER,
    org_id: ORG,
    email: 'a@b.co',
    password_hash: null,
  })),
  lookupUserById: jest.fn(),
  markTermsAccepted: jest.fn(),
  pgErrorCode: jest.fn(),
  pgErrorMessage: jest.fn(() => ''),
  updatePasswordHash: jest.fn(),
}));
jest.mock('@/lib/auth-security', () => ({
  clearFailedLogins: jest.fn(),
  isAccountLocked: jest.fn(async () => ({ locked })),
  loadTotpState: jest.fn(async () => ({ enabled: false, secret: null })),
  recordFailedLogin: jest.fn(),
}));

function loginRequest() {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co', password: 'WrongPassword1!' }),
  });
}

describe('login failure audit', () => {
  beforeEach(() => {
    audit.mockClear();
    locked = false;
  });

  it('records a denied login event on wrong credentials', async () => {
    const res = await POST(loginRequest(), { params: Promise.resolve({ path: ['login'] }) });
    expect(res.status).toBe(401);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        kind: 'login',
        resultStatus: 'denied',
        payload: expect.objectContaining({ reason: 'wrong_password' }),
      })
    );
  });

  it('never blocks the auth response when the audit insert fails', async () => {
    audit.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(loginRequest(), { params: Promise.resolve({ path: ['login'] }) });
    expect(res.status).toBe(401);
  });
});
