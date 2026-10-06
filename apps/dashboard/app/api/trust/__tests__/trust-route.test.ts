/**
 * @jest-environment node
 *
 * One read for the whole Trust page: where the team is, what it may do there, what it would take to
 * move up, and the record behind both. Everything is measured by the server for the session's own
 * workspace.
 */
import type { TrustSnapshot } from '@/lib/trust-query';
import { summariseEmployee } from '@/lib/trust-evidence';

const ORG = '11111111-1111-4111-8111-111111111111';
let role = 'owner';
let snapshot: TrustSnapshot;

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { release: jest.fn() }, orgId: ORG, userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/rbac', () => ({
  canReadOperations: (r: string) => r !== 'billing',
  canManageOrgSettings: (r: string) => r === 'owner' || r === 'admin',
  canApproveActions: (r: string) => r === 'owner' || r === 'admin' || r === 'member',
  loadHumanRole: jest.fn(async () => role),
}));
jest.mock('@/lib/trust-query', () => ({ collectTrustSnapshot: jest.fn(async () => snapshot) }));

import { GET } from '../route';

const empty = summariseEmployee({
  approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, waiting: 0, failedToRun: 0,
  carriedOut: 0, withProblems: 0, outcomesTracked: false, lastDecisionAt: null,
});

beforeEach(() => {
  role = 'owner';
  snapshot = {
    stage: 0, killSwitch: false, since: '2026-09-01T00:00:00.000Z', sinceApproximate: false,
    workspace: {
      stage: 0, killSwitch: false, weeksInStage: 5, stateDivergences: 0, shadowReviewed: 32, shadowAgreed: 30,
      decisionsInStage: 0, approvalRate: null, recentDecided: 0, recentApprovalRate: null,
    },
    employees: [{ id: 'e-1', name: 'Maya', role: 'customer', status: 'active', evidence: empty }],
    unattributed: empty,
    shadow: { reviewed: 32, agreed: 30, waiting: 6 },
    outcomesTracked: false,
    history: [],
    asOf: '2026-10-06T00:00:00.000Z',
  };
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/trust', () => {
  it('answers with the level, what the team may do at each level, and what moving up would take', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ orgId: ORG, stage: 0, killSwitch: false, canManage: true, canReview: true, outcomesTracked: false });
    expect(body.workspace).toMatchObject({ shadowReviewed: 32, shadowAgreed: 30, weeksInStage: 5 });
    expect(body.levels).toHaveLength(4);
    expect(body.levels[0].rows).toHaveLength(5);
    expect(body.levels.map((l: { sameAsPrevious: boolean }) => l.sameAsPrevious)).toEqual([false, false, true, true]);
    expect(body.recommendation.kind).toBe('hold');
    expect(body.recommendation.requirements.map((r: { id: string }) => r.id)).toEqual(['shadow_reviewed', 'shadow_agreement']);
    expect(body.recommendation.requirements[0]).toMatchObject({ have: 32, need: 50, met: false });
    expect(body.employees[0]).toMatchObject({ id: 'e-1', name: 'Maya' });
  });

  it('tells a person who cannot manage settings that they can look but not change', async () => {
    role = 'member';
    const body = await (await GET()).json();
    expect(body.canManage).toBe(false);
    expect(body.canReview).toBe(true);
  });

  it('is closed to roles that cannot read operations', async () => {
    role = 'billing';
    expect((await GET()).status).toBe(403);
  });

  it('never includes anything about another workspace: one snapshot, for the session workspace', async () => {
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toMatch(/22222222-2222/);
    expect(body.orgId).toBe(ORG);
  });

  it('answers 500 with a plain message, and logs, when the evidence cannot be read', async () => {
    const q = jest.requireMock('@/lib/trust-query') as { collectTrustSnapshot: jest.Mock };
    q.collectTrustSnapshot.mockRejectedValueOnce(new Error('relation "agent_shadow_reviews" does not exist'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/agent_shadow_reviews|relation/);
    expect(console.error).toHaveBeenCalled();
  });
});
