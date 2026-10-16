import {
  MIN_DECIDED_TO_JUDGE,
  PULL_BACK,
  recommendStage,
  summariseEmployee,
  type EmployeeCounts,
  type WorkspaceEvidence,
} from '../trust-evidence';

const none: EmployeeCounts = {
  approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, waiting: 0, failedToRun: 0,
  carriedOut: 0, withProblems: 0, outcomesTracked: false, lastDecisionAt: null,
};
const emp = (o: Partial<EmployeeCounts>) => summariseEmployee({ ...none, ...o });

describe('summariseEmployee', () => {
  it('counts only decisions a person actually made', () => {
    const e = emp({ approvedAsIs: 6, approvedEdited: 2, rejected: 2, expired: 5, waiting: 4 });
    expect(e.decided).toBe(10);
    expect(e.approvalRate).toBeCloseTo(0.8);
    expect(e.asIsRate).toBeCloseTo(0.6);
  });

  it('says nothing, rather than 0% or 100%, when nobody has decided anything', () => {
    const e = emp({ expired: 3 });
    expect(e.approvalRate).toBeNull();
    expect(e.asIsRate).toBeNull();
    expect(e.enough).toBe(false);
    expect(e.stillNeeded).toBe(MIN_DECIDED_TO_JUDGE);
  });

  it('refuses to judge a small sample: 3 of 3 approved is not a track record', () => {
    const e = emp({ approvedAsIs: 3 });
    expect(e.approvalRate).toBe(1);
    expect(e.enough).toBe(false);
    expect(e.stillNeeded).toBe(MIN_DECIDED_TO_JUDGE - 3);
    expect(e.concerns).toEqual([]);
  });

  it('flags an employee whose proposals are mostly turned down, but only once there is enough to judge', () => {
    expect(emp({ approvedAsIs: 3, rejected: 9 }).concerns).toEqual([]); // 12 decided, below the 20 needed to act on it
    const e = emp({ approvedAsIs: 6, rejected: 16 });
    expect(e.decided).toBe(22);
    expect(e.concerns).toContain('many_turned_down');
  });

  it('flags approved actions that then failed to run', () => {
    expect(emp({ approvedAsIs: 20, failedToRun: 2 }).concerns).not.toContain('often_fails');
    expect(emp({ approvedAsIs: 20, failedToRun: 6 }).concerns).toContain('often_fails');
  });

  it('flags approvals that nobody answered before they expired', () => {
    expect(emp({ approvedAsIs: 10, expired: 2 }).concerns).not.toContain('approvals_expiring');
    expect(emp({ approvedAsIs: 10, expired: 6 }).concerns).toContain('approvals_expiring');
  });

  it('only talks about undone actions and complaints when something records them', () => {
    const untracked = emp({ carriedOut: 40, withProblems: 0, outcomesTracked: false });
    expect(untracked.problemRate).toBeNull();
    expect(untracked.concerns).not.toContain('often_undone');
    const tracked = emp({ carriedOut: 40, withProblems: 8, outcomesTracked: true });
    expect(tracked.problemRate).toBeCloseTo(0.2);
    expect(tracked.concerns).toContain('often_undone');
  });

  it('never returns NaN or negative numbers for odd input', () => {
    const e = emp({ approvedAsIs: -2, rejected: 0 });
    for (const v of [e.decided, e.stillNeeded]) expect(Number.isFinite(v) && v >= 0).toBe(true);
  });
});

const ws = (o: Partial<WorkspaceEvidence> = {}): WorkspaceEvidence => ({
  stage: 0, killSwitch: false, weeksInStage: 0, stateDivergences: 0,
  shadowReviewed: 0, shadowAgreed: 0, decisionsInStage: 0, approvalRate: null,
  recentDecided: 0, recentApprovalRate: null, ...o,
});

describe('recommendStage', () => {
  it('holds a brand-new workspace in watching mode and says what is missing', () => {
    const r = recommendStage(ws());
    expect(r.kind).toBe('hold');
    expect(r.requirements.map((x) => x.id)).toEqual(['shadow_reviewed', 'shadow_agreement']);
    expect(r.requirements.every((x) => !x.met)).toBe(true);
  });

  it('recommends moving up only when every requirement is met on measured numbers', () => {
    expect(recommendStage(ws({ shadowReviewed: 50, shadowAgreed: 46 })).kind).toBe('advance');
    expect(recommendStage(ws({ shadowReviewed: 50, shadowAgreed: 40 })).kind).toBe('hold');
    expect(recommendStage(ws({ shadowReviewed: 49, shadowAgreed: 49 })).kind).toBe('hold');
  });

  it('keeps the existing exit rules for the next stages', () => {
    expect(recommendStage(ws({ stage: 1, weeksInStage: 3, approvalRate: 0.75 })).kind).toBe('advance');
    expect(recommendStage(ws({ stage: 1, weeksInStage: 3, approvalRate: 0.75, stateDivergences: 1 })).kind).toBe('hold');
    expect(recommendStage(ws({ stage: 2, decisionsInStage: 120, approvalRate: 0.85 })).kind).toBe('advance');
  });

  it('is steady at the last stage', () => {
    expect(recommendStage(ws({ stage: 3, recentDecided: 40, recentApprovalRate: 0.9 })).kind).toBe('steady');
  });

  it('recommends pulling back when recent proposals are mostly turned down', () => {
    const r = recommendStage(ws({ stage: 2, recentDecided: PULL_BACK.minDecided, recentApprovalRate: PULL_BACK.approvalBelow - 0.05, decisionsInStage: 150, approvalRate: 0.9 }));
    expect(r.kind).toBe('pull_back');
    expect(r.reasons).toContain('recent_approval_low');
  });

  it('does not pull back on a handful of decisions', () => {
    const r = recommendStage(ws({ stage: 2, recentDecided: PULL_BACK.minDecided - 1, recentApprovalRate: 0.1 }));
    expect(r.kind).not.toBe('pull_back');
  });

  it('never recommends pulling back from watching mode: there is nowhere lower to go', () => {
    expect(recommendStage(ws({ stage: 0, recentDecided: 100, recentApprovalRate: 0 })).kind).toBe('hold');
  });

  it('pull-back wins over advance, so a workspace is never told to climb and descend at once', () => {
    const r = recommendStage(ws({ stage: 1, weeksInStage: 5, approvalRate: 0.75, recentDecided: 30, recentApprovalRate: 0.4 }));
    expect(r.kind).toBe('pull_back');
  });

  it('holds while the pause switch is on, whatever the numbers say', () => {
    const r = recommendStage(ws({ stage: 1, killSwitch: true, weeksInStage: 5, approvalRate: 0.75 }));
    expect(r.kind).toBe('hold');
    expect(r.reasons).toContain('paused');
  });
});
