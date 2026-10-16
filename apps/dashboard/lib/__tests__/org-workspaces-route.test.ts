/**
 * @jest-environment node
 *
 * POST /api/org/workspaces: validation, client org_id rejection, per-user cap,
 * and the happy path (create, attach as owner, rotate cookies, 201).
 */
const NEW_ORG = '00000000-0000-0000-0000-0000000000cc';
const query = jest.fn();
const createWorkspaceOrg = jest.fn(async () => NEW_ORG);
const attachUserToOrg = jest.fn(async () => undefined);
const applySessionCookies = jest.fn(async () => undefined);

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    client: { query, release: jest.fn() },
    orgId: '00000000-0000-0000-0000-0000000000aa',
    userId: '00000000-0000-0000-0000-0000000000bb',
    sessionEpoch: 2,
  })),
  scopedAuthErrorResponse: () => null,
  createWorkspaceOrg: (...a: unknown[]) => (createWorkspaceOrg as (...x: unknown[]) => unknown)(...a),
}));
jest.mock('@/lib/auth-user', () => ({ attachUserToOrg: (...a: unknown[]) => (attachUserToOrg as (...x: unknown[]) => unknown)(...a) }));
jest.mock('@/lib/session-cookie', () => ({ applySessionCookies: (...a: unknown[]) => (applySessionCookies as (...x: unknown[]) => unknown)(...a) }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn(async () => undefined) }));

import { POST } from '../../app/api/org/workspaces/route';

const req = (body: unknown) =>
  new Request('http://x/api/org/workspaces', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  jest.clearAllMocks();
  query.mockImplementation(async (sql: string) =>
    /COUNT\(\*\)/.test(sql) ? { rows: [{ n: '1' }] } : { rows: [] }
  );
});

describe('POST /api/org/workspaces', () => {
  it('rejects a blank name', async () => {
    expect((await POST(req({ name: '  ' }))).status).toBe(400);
    expect(createWorkspaceOrg).not.toHaveBeenCalled();
  });

  it('rejects a client-sent org id', async () => {
    expect((await POST(req({ name: 'Acme', org_id: NEW_ORG }))).status).toBe(400);
    expect(createWorkspaceOrg).not.toHaveBeenCalled();
  });

  it('refuses past the per-user workspace cap', async () => {
    query.mockImplementation(async () => ({ rows: [{ n: '10' }] }));
    expect((await POST(req({ name: 'Acme' }))).status).toBe(409);
    expect(createWorkspaceOrg).not.toHaveBeenCalled();
  });

  it('creates the workspace, makes the user owner and rotates cookies', async () => {
    const res = await POST(req({ name: '  Acme   Pune ' }));
    expect(res.status).toBe(201);
    expect(createWorkspaceOrg).toHaveBeenCalledWith(expect.anything(), 'Acme Pune');
    expect(attachUserToOrg).toHaveBeenCalledWith(expect.anything(), '00000000-0000-0000-0000-0000000000bb', NEW_ORG, 'owner');
    expect(applySessionCookies).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: NEW_ORG, onboardingComplete: false, sessionEpoch: 2 })
    );
    expect(await res.json()).toMatchObject({ success: true, activeOrg: { id: NEW_ORG, name: 'Acme Pune', role: 'owner' } });
  });
});
