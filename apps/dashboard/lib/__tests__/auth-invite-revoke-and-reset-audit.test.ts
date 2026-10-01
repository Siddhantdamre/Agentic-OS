/**
 * @jest-environment node
 *
 * Revoke-invite RBAC and password-reset audit rows (auth.md P1).
 */
import { DELETE } from '@/app/api/org/invites/[id]/route';
import { POST as resetPost } from '@/app/api/auth/reset-password/route';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';
const INVITE = '00000000-0000-4000-8000-0000000000cc';

const audit = jest.fn(async (_p: unknown) => undefined);
let role = 'admin';
let deleted: Array<{ email: string; role: string }> = [{ email: 'x@y.co', role: 'member' }];
const query = jest.fn(async (sql: string) => {
  if (/DELETE FROM org_invites/.test(sql)) return { rows: deleted };
  if (/auth_consume_password_reset/.test(sql)) return { rows: [{ auth_consume_password_reset: USER }] };
  return { rows: [] };
});
const release = jest.fn();

jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: (p: unknown) => audit(p) }));
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: ORG, userId: USER })),
  scopedAuthErrorResponse: () => null,
  pool: { connect: jest.fn(async () => ({ query, release })) },
}));
jest.mock('@/lib/rbac', () => ({
  loadHumanRole: jest.fn(async () => role),
  canManageOrgSettings: (r: string) => r === 'owner' || r === 'admin',
}));
jest.mock('@/lib/rate-limit', () => ({
  clientIpFromRequest: () => '127.0.0.1',
  denyAuthIfLimited: () => null,
}));
jest.mock('@/lib/auth-user', () => ({
  updatePasswordHash: jest.fn(),
  lookupUserById: jest.fn(async () => ({ id: USER, org_id: ORG })),
}));

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://localhost/api/org/invites/x', { method: 'DELETE' });

beforeEach(() => {
  audit.mockClear();
  query.mockClear();
  role = 'admin';
  deleted = [{ email: 'x@y.co', role: 'member' }];
});

describe('revoke invite', () => {
  it('rejects non-uuid ids', async () => {
    expect((await DELETE(req(), ctx('nope'))).status).toBe(400);
  });
  it('forbids members and auditors without touching the table', async () => {
    role = 'member';
    expect((await DELETE(req(), ctx(INVITE))).status).toBe(403);
    expect(query.mock.calls.some(([s]) => /DELETE/.test(s))).toBe(false);
  });
  it('404s when nothing pending matched', async () => {
    deleted = [];
    expect((await DELETE(req(), ctx(INVITE))).status).toBe(404);
  });
  it('deletes scoped to the session org and audits', async () => {
    const res = await DELETE(req(), ctx(INVITE));
    expect(res.status).toBe(200);
    const call = query.mock.calls.find(([s]) => /DELETE/.test(s)) as unknown as [string, unknown[]];
    expect(call[1]).toEqual([INVITE, ORG]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'member.remove', action: 'invite.revoked' }));
  });
});

describe('password reset consume audit', () => {
  it('records password.reset_completed', async () => {
    const res = await resetPost(
      new Request('http://localhost/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'tok', password: 'LongEnough1!' }),
      })
    );
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'password.reset', action: 'password.reset_completed', orgId: ORG })
    );
  });
});
