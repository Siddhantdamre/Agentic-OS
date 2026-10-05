/**
 * @jest-environment node
 *
 * Saving an autonomy rule is select-then-insert. Two saves of the same rule at once (a double click, two
 * tabs) both see "no rule yet", and the second INSERT violates uq_employee_autonomy_rules_action. That is
 * the other person's identical request, not a failure: the loser must fall back to updating the row the
 * winner just created and answer 200, not 500.
 */
const calls: Array<{ sql: string; params: unknown[] }> = [];
let existingVisible = false; // what the first SELECT sees: nothing, because the winner has not committed yet

const client = {
  release: jest.fn(),
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (/SELECT id FROM employee_autonomy_rules/i.test(s)) {
      return { rows: existingVisible ? [{ id: 'rule-1' }] : [] };
    }
    if (/INSERT INTO employee_autonomy_rules/i.test(s)) {
      // the winner committed between our SELECT and our INSERT
      existingVisible = true;
      const err = new Error('duplicate key value violates unique constraint "uq_employee_autonomy_rules_action"') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    return { rows: [], rowCount: 1 };
  }),
};

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client, orgId: '11111111-1111-4111-8111-111111111111', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));
jest.mock('@/lib/rbac', () => ({
  canManageOrgSettings: () => true,
  canReadOperations: () => true,
  loadHumanRole: jest.fn(async () => 'owner'),
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn(async () => undefined) }));

import { PATCH } from '../route';

const patch = async (body: unknown): Promise<Response> =>
  (await PATCH(new Request('http://x/api/settings/autonomy', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))) as Response;

beforeEach(() => {
  calls.length = 0;
  existingVisible = false;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('PATCH /api/settings/autonomy — concurrent save of the same rule', () => {
  it('answers 200 when its INSERT loses the race', async () => {
    const res = await patch({ actionType: 'send_email', autonomyTier: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, actionType: 'send_email', autonomyTier: 2 });
  });

  it("then applies the caller's values to the row the winner created", async () => {
    await patch({ actionType: 'send_email', autonomyTier: 3, reversibility: 'irreversible' });
    const update = calls.find((c) => /UPDATE employee_autonomy_rules/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update?.params).toContain(3);
    expect(update?.params).toContain('irreversible');
  });

  it('still answers 400 for a missing actionType, 500 only for genuine failures', async () => {
    expect((await patch({ autonomyTier: 2 })).status).toBe(400);
    client.query.mockImplementationOnce(async () => {
      throw new Error('connection terminated');
    });
    expect((await patch({ actionType: 'send_email', autonomyTier: 2 })).status).toBe(500);
  });
});
