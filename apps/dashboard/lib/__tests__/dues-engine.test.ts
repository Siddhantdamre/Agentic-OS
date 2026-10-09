import { appointedDay, daysOverdue, msmeInterest, nextChaseStep, type Due } from '../dues-engine';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('appointedDay (MSMED s.15)', () => {
  it('uses the agreed credit period when it is 45 days or less', () => {
    expect(appointedDay(d('2026-01-01'), 30)).toEqual(d('2026-01-31'));
  });
  it('caps an agreed period at 45 days', () => {
    expect(appointedDay(d('2026-01-01'), 90)).toEqual(d('2026-02-15'));
  });
  it('uses 15 days when nothing was agreed', () => {
    expect(appointedDay(d('2026-01-01'), null)).toEqual(d('2026-01-16'));
  });
});

describe('daysOverdue', () => {
  it('is zero on and before the due day', () => {
    expect(daysOverdue(d('2026-02-01'), d('2026-02-01'))).toBe(0);
    expect(daysOverdue(d('2026-02-01'), d('2026-01-20'))).toBe(0);
  });
  it('counts whole days after the due day', () => {
    expect(daysOverdue(d('2026-02-01'), d('2026-02-11'))).toBe(10);
  });
});

describe('msmeInterest (three times the bank rate, monthly rests)', () => {
  it('is zero when not overdue or when the bank rate is missing', () => {
    expect(msmeInterest(100000, d('2026-02-01'), d('2026-02-01'), 5.5)).toBe(0);
    expect(msmeInterest(100000, d('2026-02-01'), d('2026-03-01'), 0)).toBe(0);
  });
  it('charges 3x the bank rate as simple interest inside the first month', () => {
    // 100000 * 16.5% * 15/365 = 678.08
    expect(msmeInterest(100000, d('2026-02-01'), d('2026-02-16'), 5.5)).toBeCloseTo(678.08, 1);
  });
  it('compounds monthly after the first full month', () => {
    const one = msmeInterest(100000, d('2026-01-01'), d('2026-02-01'), 5.5); // one full month
    const three = msmeInterest(100000, d('2026-01-01'), d('2026-04-01'), 5.5); // three full months
    const monthly = 0.165 / 12;
    expect(one).toBeCloseTo(100000 * monthly, 0);
    expect(three).toBeCloseTo(100000 * (Math.pow(1 + monthly, 3) - 1), 0);
  });
  it('rounds to paise', () => {
    const v = msmeInterest(12345.67, d('2026-01-01'), d('2026-01-20'), 5.5);
    expect(Math.round(v * 100)).toBe(v * 100);
  });
});

describe('nextChaseStep', () => {
  const due = (over: Partial<Due> = {}): Due => ({ amount: 50000, dueDate: d('2026-02-01'), status: 'open', lastReminderAt: null, remindersSent: 0, ...over });

  it('never chases something already paid or in dispute', () => {
    expect(nextChaseStep(due({ status: 'paid' }), d('2026-03-01')).action).toBe('none');
    expect(nextChaseStep(due({ status: 'disputed' }), d('2026-03-01')).action).toBe('owner_review');
  });
  it('does nothing before the due date', () => {
    expect(nextChaseStep(due(), d('2026-01-30')).action).toBe('none');
  });
  it('starts friendly a few days after the due date', () => {
    const s = nextChaseStep(due(), d('2026-02-04'));
    expect(s).toMatchObject({ action: 'remind', tone: 'friendly' });
  });
  it('gets firmer as the delay grows and mentions interest only once it is a legal claim', () => {
    expect(nextChaseStep(due({ remindersSent: 1, lastReminderAt: d('2026-02-04') }), d('2026-02-15'))).toMatchObject({ action: 'remind', tone: 'firm' });
    const formal = nextChaseStep(due({ remindersSent: 2, lastReminderAt: d('2026-02-15') }), d('2026-03-10'));
    expect(formal).toMatchObject({ action: 'remind', tone: 'formal', mentionInterest: true });
  });
  it('waits at least 3 days between reminders so a buyer is never pestered', () => {
    const s = nextChaseStep(due({ remindersSent: 1, lastReminderAt: d('2026-02-10') }), d('2026-02-12'));
    expect(s.action).toBe('wait');
  });
  it('after 60 days overdue it prepares the escalation pack for the owner, and still never sends by itself', () => {
    const s = nextChaseStep(due({ remindersSent: 4, lastReminderAt: d('2026-03-20') }), d('2026-04-15'));
    expect(s.action).toBe('escalation_pack');
    expect(s.needsOwnerApproval).toBe(true);
  });
  it('every message to a buyer needs the owner to approve it', () => {
    expect(nextChaseStep(due(), d('2026-02-04')).needsOwnerApproval).toBe(true);
  });
});
