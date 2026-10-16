import { assessAgent, assessWorkspace, orderByAttention, type AgentHealthInput } from '../agent-health';

const NOW = new Date('2026-10-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

const base: AgentHealthInput = {
  name: 'Emma',
  role: 'Customer Support',
  status: 'active',
  createdAt: daysAgo(30),
  lastActionAt: daysAgo(1),
  waiting: 0,
  oldestWaitingHours: null,
  decided: 20,
  approvedAsIs: 16,
  approvedEdited: 2,
  rejected: 2,
  failedToRun: 0,
};

describe('agent health, in plain words', () => {
  it('is fine when it has acted lately and people mostly accept its work', () => {
    const r = assessAgent(base, NOW);
    expect(r.status).toBe('ok');
    expect(r.reasons).toEqual([]);
  });

  it('says paused for a paused or archived employee and does not judge it', () => {
    expect(assessAgent({ ...base, status: 'paused', lastActionAt: null }, NOW).status).toBe('paused');
    expect(assessAgent({ ...base, status: 'archived' }, NOW).status).toBe('paused');
  });

  it('a brand new employee with no history is new, not unhealthy', () => {
    const r = assessAgent({ ...base, createdAt: daysAgo(1), lastActionAt: null, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0 }, NOW);
    expect(r.status).toBe('new');
  });

  it('a new employee with an approval waiting three days is stuck, not just started', () => {
    const r = assessAgent({ ...base, createdAt: daysAgo(1), lastActionAt: null, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0, waiting: 2, oldestWaitingHours: 72 }, NOW);
    expect(r.status).toBe('stuck');
  });

  it('an older employee that has never done anything is on watch', () => {
    const r = assessAgent({ ...base, lastActionAt: null, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0 }, NOW);
    expect(r.status).toBe('watch');
    expect(r.reasons[0]).toMatch(/has not done anything yet/i);
  });

  it('no activity for a week is on watch and names the days', () => {
    const r = assessAgent({ ...base, lastActionAt: daysAgo(9) }, NOW);
    expect(r.status).toBe('watch');
    expect(r.reasons[0]).toMatch(/9 days/);
  });

  it('approvals waiting more than two days make it stuck, because nothing moves until a person decides', () => {
    const r = assessAgent({ ...base, waiting: 3, oldestWaitingHours: 60 }, NOW);
    expect(r.status).toBe('stuck');
    expect(r.reasons[0]).toMatch(/3 approvals are waiting; the oldest for 2 days/);
  });

  it('a waiting approval under two days old is normal', () => {
    expect(assessAgent({ ...base, waiting: 2, oldestWaitingHours: 20 }, NOW).status).toBe('ok');
  });

  it('actions that keep failing when they run make it stuck', () => {
    const r = assessAgent({ ...base, failedToRun: 4 }, NOW);
    expect(r.status).toBe('stuck');
    expect(r.reasons.join(' ')).toMatch(/4 .*failed to run/i);
  });

  it('one failure among many is not a pattern', () => {
    expect(assessAgent({ ...base, failedToRun: 1 }, NOW).status).toBe('ok');
  });

  it('people rewriting a lot of its drafts is on watch, with the count', () => {
    const r = assessAgent({ ...base, decided: 10, approvedAsIs: 3, approvedEdited: 5, rejected: 2 }, NOW);
    expect(r.status).toBe('watch');
    expect(r.reasons.join(' ')).toMatch(/rewrote 5 of its 10/i);
  });

  it('many turned down is on watch', () => {
    const r = assessAgent({ ...base, decided: 10, approvedAsIs: 5, approvedEdited: 0, rejected: 5 }, NOW);
    expect(r.status).toBe('watch');
    expect(r.reasons.join(' ')).toMatch(/turned down 5 of 10/i);
  });

  it('too few decisions to talk about rates', () => {
    const r = assessAgent({ ...base, decided: 4, approvedAsIs: 0, approvedEdited: 3, rejected: 1 }, NOW);
    expect(r.status).toBe('ok');
  });

  it('stuck outranks watch when both apply, and every reason is kept', () => {
    const r = assessAgent({ ...base, lastActionAt: daysAgo(10), waiting: 1, oldestWaitingHours: 80 }, NOW);
    expect(r.status).toBe('stuck');
    expect(r.reasons.length).toBe(2);
  });

  it('puts what needs a person first', () => {
    const list = ['ok', 'paused', 'stuck', 'new', 'watch'].map((status) => ({ status })) as any;
    expect(orderByAttention(list).map((x: any) => x.status)).toEqual(['stuck', 'watch', 'ok', 'new', 'paused']);
  });
});

describe('workspace notes', () => {
  it('says nothing when everything is normal', () => {
    expect(assessWorkspace({ webhookFailuresWaiting: 0, killSwitch: false })).toEqual([]);
  });

  it('names customer messages that failed to arrive', () => {
    const n = assessWorkspace({ webhookFailuresWaiting: 3, killSwitch: false });
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/3 customer messages/);
    expect(n[0].level).toBe('watch');
  });

  it('says the kill switch is on', () => {
    const n = assessWorkspace({ webhookFailuresWaiting: 0, killSwitch: true });
    expect(n[0].level).toBe('stuck');
    expect(n[0].text).toMatch(/switched off/i);
  });
});
