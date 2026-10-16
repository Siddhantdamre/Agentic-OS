/**
 * @jest-environment node
 *
 * Moving a workspace up a level has to be earned on numbers the server counted. The old route
 * asked the browser for the evidence (weeks in stage, approval rate, decisions) and checked
 * the answer, so anyone allowed to change settings could type their way up. These tests send
 * exactly that and expect it to be ignored.
 */
import type { TrustSnapshot } from '@/lib/trust-query';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let failOn: RegExp | null = null;

const client = {
  release: jest.fn(),
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    calls.push({ sql: s, params });
    if (failOn && failOn.test(s)) throw new Error('boom');
    return { rows: [], rowCount: 1 };
  }),
};

let role = 'owner';
let snapshot: TrustSnapshot;

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client, orgId: '11111111-1111-4111-8111-111111111111', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/rbac', () => ({
  canManageOrgSettings: (r: string) => r === 'owner' || r === 'admin',
  loadHumanRole: jest.fn(async () => role),
}));
const audit = jest.fn(async () => undefined);
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: (...a: unknown[]) => audit(...(a as [])) }));
jest.mock('@/lib/trust-query', () => ({ collectTrustSnapshot: jest.fn(async () => snapshot) }));

import { GET, PATCH } from '../route';

const base = (over: Partial<TrustSnapshot['workspace']> = {}, top: Partial<TrustSnapshot> = {}): TrustSnapshot => ({
  stage: 0,
  killSwitch: false,
  since: '2026-09-01T00:00:00.000Z',
  sinceApproximate: false,
  workspace: {
    stage: 0, killSwitch: false, weeksInStage: 0, stateDivergences: 0, shadowReviewed: 3, shadowAgreed: 3,
    decisionsInStage: 0, approvalRate: null, recentDecided: 0, recentApprovalRate: null, ...over,
  },
  employees: [],
  unattributed: {} as TrustSnapshot['unattributed'],
  shadow: { reviewed: 3, agreed: 3, waiting: 0 },
  outcomesTracked: false,
  history: [],
  asOf: '2026-10-06T00:00:00.000Z',
  ...top,
});

const patch = async (body: unknown) =>
  PATCH(new Request('http://x/api/org/rollout', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

const wrote = () => calls.filter((c) => /INSERT INTO org_runtime_controls|INSERT INTO org_autonomy_stage_events/i.test(c.sql));
const stageWrite = () => calls.find((c) => /INSERT INTO org_runtime_controls/i.test(c.sql));
const eventWrite = () => calls.find((c) => /INSERT INTO org_autonomy_stage_events/i.test(c.sql));

beforeEach(() => {
  calls.length = 0;
  failOn = null;
  role = 'owner';
  audit.mockClear();
  snapshot = base();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('PATCH /api/org/rollout', () => {
  it('refuses people who may not change settings, and changes nothing', async () => {
    role = 'member';
    const res = await patch({ stage: 1 });
    expect(res.status).toBe(403);
    expect(wrote()).toHaveLength(0);
  });

  it('ignores evidence typed into the request: only 3 shadow decisions were reviewed, whatever the body says', async () => {
    const res = await patch({
      stage: 1, shadowReviewed: 500, shadowAgreed: 500, weeksInStage: 9, stateDivergences: 0, approvalRate: 0.8, decisionsInStage: 900,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/50 .*reviewed/i);
    expect(wrote()).toHaveLength(0);
  });

  it('moves up when the measured evidence is enough, and records the evidence it relied on', async () => {
    snapshot = base({ shadowReviewed: 50, shadowAgreed: 47 });
    const res = await patch({ stage: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 1 });
    expect(stageWrite()?.params).toEqual(['11111111-1111-4111-8111-111111111111', 1]);
    const ev = eventWrite();
    expect(ev?.params.slice(0, 4)).toEqual(['11111111-1111-4111-8111-111111111111', 0, 1, 'advance']);
    expect(JSON.parse(String(ev?.params[5]))).toMatchObject({ workspace: { shadowReviewed: 50, shadowAgreed: 47 } });
    expect(ev?.params[6]).toBe('u-1');
  });

  it('lets a manager override the check, but the override is recorded as one, with their reason', async () => {
    const res = await patch({ stage: 1, force: true, reason: 'Pilot customer asked for it' });
    expect(res.status).toBe(200);
    const ev = eventWrite();
    expect(ev?.params.slice(0, 5)).toEqual(['11111111-1111-4111-8111-111111111111', 0, 1, 'override', 'Pilot customer asked for it']);
  });

  it('keeps a reason to a sensible length', async () => {
    await patch({ stage: 1, force: true, reason: 'x'.repeat(5000) });
    expect(String(eventWrite()?.params[4]).length).toBe(500);
  });

  it('moves up one level at a time, even with an override', async () => {
    const res = await patch({ stage: 2, force: true });
    expect(res.status).toBe(400);
    expect(wrote()).toHaveLength(0);
  });

  it('refuses to move up while the team is paused, even with an override', async () => {
    snapshot = base({ shadowReviewed: 60, shadowAgreed: 60, killSwitch: true }, { killSwitch: true });
    const res = await patch({ stage: 1, force: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/paused/i);
    expect(wrote()).toHaveLength(0);
  });

  it('always allows going back, and records it', async () => {
    snapshot = base({ stage: 2 }, { stage: 2 });
    const res = await patch({ stage: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 1, demoted: true });
    expect(eventWrite()?.params.slice(1, 4)).toEqual([2, 1, 'pull_back']);
  });

  it('does nothing, and records nothing, when the level is already that level', async () => {
    snapshot = base({ stage: 1 }, { stage: 1 });
    const res = await patch({ stage: 1 });
    expect(res.status).toBe(200);
    expect(wrote()).toHaveLength(0);
  });

  it('rejects a level that is not 0 to 3 instead of quietly treating it as 0', async () => {
    for (const stage of [undefined, 'high', 9, -1, 1.5, null]) {
      const res = await patch({ stage });
      expect(res.status).toBe(400);
    }
    expect(wrote()).toHaveLength(0);
  });

  it('refuses an org id from the browser', async () => {
    const res = await patch({ stage: 1, org_id: '22222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(400);
  });

  it('writes the new level and its history together or not at all', async () => {
    snapshot = base({ shadowReviewed: 50, shadowAgreed: 50 });
    failOn = /INSERT INTO org_autonomy_stage_events/i;
    const res = await patch({ stage: 1 });
    expect(res.status).toBe(500);
    const order = calls.map((c) => c.sql.trim().split(/\s+/)[0].toUpperCase());
    expect(order).toContain('BEGIN');
    expect(order).toContain('ROLLBACK');
    expect(order).not.toContain('COMMIT');
    expect(audit).not.toHaveBeenCalled();
  });

  it('records the change in the audit log', async () => {
    snapshot = base({ shadowReviewed: 50, shadowAgreed: 50 });
    await patch({ stage: 1 });
    expect(audit).toHaveBeenCalledTimes(1);
    const [entry] = audit.mock.calls[0] as unknown as [{ kind: string; payload: Record<string, unknown> }];
    expect(entry.kind).toBe('settings.update');
    expect(entry.payload).toMatchObject({ setting: 'autonomy_stage', from: 0, to: 1, kind: 'advance' });
  });
});

describe('GET /api/org/rollout', () => {
  it('reports the review counts the server measured, in the shape existing callers expect', async () => {
    snapshot = base({ shadowReviewed: 12, shadowAgreed: 11 }, { shadow: { reviewed: 12, agreed: 11, waiting: 4 } });
    const res = await GET();
    expect(await res.json()).toEqual({
      orgId: '11111111-1111-4111-8111-111111111111', stage: 0, killSwitch: false, shadowReviewed: 12, shadowAgreed: 11,
    });
  });
});
