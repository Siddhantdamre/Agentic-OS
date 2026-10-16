/**
 * @jest-environment node
 *
 * The first level exit needs 50 operator answers to "would you have done this?". Each answer is one
 * row; the count is made from those rows, so an answer has to come from a person allowed to approve
 * actions, about a real watching-mode decision in their own workspace.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const LEDGER = '33333333-3333-4333-8333-333333333333';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let decisionExists = true;

const client = {
  release: jest.fn(),
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/FROM agent_decision_ledger\s+WHERE id = \$1/i.test(s)) return { rows: decisionExists ? [{ id: LEDGER }] : [] };
    if (/COUNT\(\*\) FILTER \(WHERE r\.id IS NULL\)/i.test(s)) return { rows: [{ waiting: '4', reviewed: '7', agreed: '6' }] };
    if (/ORDER BY l\.created_at DESC/i.test(s)) {
      return { rows: [{ id: LEDGER, created_at: '2026-10-05T10:00:00Z', employee_name: 'Maya', employee_role: 'customer', action_considered: 'gmail.send_email', summary: 'Send email "Hi" to a@b.co' }] };
    }
    return { rows: [], rowCount: 1 };
  }),
};

let role = 'member';
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client, orgId: ORG, userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/rbac', () => ({
  canApproveActions: (r: string) => r === 'owner' || r === 'admin' || r === 'member',
  canReadOperations: (r: string) => r !== 'billing',
  loadHumanRole: jest.fn(async () => role),
}));

import { GET, POST } from '../route';

const post = async (body: unknown) =>
  POST(new Request('http://x/api/trust/shadow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const writes = () => calls.filter((c) => /INSERT INTO agent_shadow_reviews/i.test(c.sql));

beforeEach(() => {
  calls.length = 0;
  role = 'member';
  decisionExists = true;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/trust/shadow', () => {
  it('lists what is waiting for an answer, in plain words, with the counts so far', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: LEDGER, employee: 'Maya', what: 'Send email "Hi" to a@b.co', at: '2026-10-05T10:00:00.000Z' }],
      waiting: 4, reviewed: 7, agreed: 6,
    });
  });

  it('is closed to roles that cannot read operations', async () => {
    role = 'billing';
    expect((await GET()).status).toBe(403);
  });
});

describe('POST /api/trust/shadow', () => {
  it('records an answer and returns the new counts', async () => {
    const res = await post({ id: LEDGER, agreed: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, waiting: 4, reviewed: 7, agreed: 6 });
    expect(writes()[0].params).toEqual([ORG, LEDGER, true, 'u-1']);
    expect(writes()[0].sql).toMatch(/ON CONFLICT \(ledger_id\) DO UPDATE/i);
  });

  it('lets a person change their answer', async () => {
    await post({ id: LEDGER, agreed: false });
    expect(writes()[0].params[2]).toBe(false);
  });

  it('is closed to roles that cannot approve actions', async () => {
    role = 'auditor';
    expect((await post({ id: LEDGER, agreed: true })).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it('answers 400 for anything that is not a decision id and a yes or no', async () => {
    for (const body of [{}, { id: 'nope', agreed: true }, { id: LEDGER }, { id: LEDGER, agreed: 'yes' }, { id: 5, agreed: true }, null]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(writes()).toHaveLength(0);
  });

  it('answers 404 when the decision is not a watching-mode decision of this workspace', async () => {
    decisionExists = false;
    const res = await post({ id: LEDGER, agreed: true });
    expect(res.status).toBe(404);
    expect(writes()).toHaveLength(0);
  });

  it('refuses an org id from the browser', async () => {
    expect((await post({ id: LEDGER, agreed: true, org_id: '22222222-2222-4222-8222-222222222222' })).status).toBe(400);
  });
});
