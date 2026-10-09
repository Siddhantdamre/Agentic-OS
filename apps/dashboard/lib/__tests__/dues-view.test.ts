import { describeDue, totalsOf, readDuesSettings, type DueRow } from '../dues-view';

const asOf = new Date('2026-10-09T00:00:00.000Z');
const row = (o: Partial<DueRow> = {}): DueRow => ({
  id: 'd1', buyer_name: 'Sharma Traders', buyer_phone: '9876543210', buyer_email: null, invoice_no: 'INV-118', amount: '120000.00',
  currency: 'INR', invoice_date: '2026-08-01', credit_days: 30, due_date: '2026-08-31', status: 'open', paid_at: null,
  last_reminder_at: null, reminders_sent: 0, note: null, ...o,
});

describe('readDuesSettings', () => {
  it('has no bank rate and is not registered until the owner says so', () => {
    expect(readDuesSettings(undefined)).toEqual({ bankRatePercent: null, msmeRegistered: false });
    expect(readDuesSettings({ dues_settings: { bankRatePercent: 5.5, msmeRegistered: true } })).toEqual({ bankRatePercent: 5.5, msmeRegistered: true });
  });
  it('ignores rubbish', () => {
    expect(readDuesSettings({ dues_settings: { bankRatePercent: 'x', msmeRegistered: 'yes' } })).toEqual({ bankRatePercent: null, msmeRegistered: false });
    expect(readDuesSettings({ dues_settings: { bankRatePercent: -3 } }).bankRatePercent).toBeNull();
  });
});

describe('describeDue', () => {
  it('works out days late, and the next step', () => {
    const v = describeDue(row(), { bankRatePercent: 5.5, msmeRegistered: true }, asOf);
    expect(v.daysLate).toBe(39);
    expect(v.amount).toBe(120000);
    expect(v.step.action).toBe('remind');
    expect(v.canRemind).toBe(true);
  });
  it('shows interest only when the owner is a registered small supplier and has set the bank rate', () => {
    expect(describeDue(row(), { bankRatePercent: 5.5, msmeRegistered: true }, asOf).interest).toBeGreaterThan(0);
    expect(describeDue(row(), { bankRatePercent: 5.5, msmeRegistered: false }, asOf).interest).toBe(0);
    expect(describeDue(row(), { bankRatePercent: null, msmeRegistered: true }, asOf).interest).toBe(0);
  });
  it('a paid due has no interest, no days late and no step', () => {
    const v = describeDue(row({ status: 'paid', paid_at: '2026-09-20T00:00:00Z' }), { bankRatePercent: 5.5, msmeRegistered: true }, asOf);
    expect(v.daysLate).toBe(0);
    expect(v.interest).toBe(0);
    expect(v.canRemind).toBe(false);
  });
  it('cannot be reminded without a phone or email, and says why', () => {
    const v = describeDue(row({ buyer_phone: null, buyer_email: null }), { bankRatePercent: null, msmeRegistered: false }, asOf);
    expect(v.canRemind).toBe(false);
    expect(v.cannotRemindBecause).toMatch(/phone or email/i);
  });
  it('prefers WhatsApp when there is a phone, email otherwise', () => {
    expect(describeDue(row(), { bankRatePercent: null, msmeRegistered: false }, asOf).channel).toBe('whatsapp');
    expect(describeDue(row({ buyer_phone: null, buyer_email: 'a@b.test' }), { bankRatePercent: null, msmeRegistered: false }, asOf).channel).toBe('email');
  });
});

describe('totalsOf', () => {
  it('adds up what is owed, what is late, and the interest, ignoring paid ones', () => {
    const s = { bankRatePercent: 5.5, msmeRegistered: true };
    const views = [
      describeDue(row({ id: 'a', amount: '1000' }), s, asOf),
      describeDue(row({ id: 'b', amount: '500', due_date: '2026-12-01' }), s, asOf),
      describeDue(row({ id: 'c', amount: '9999', status: 'paid' }), s, asOf),
    ];
    const t = totalsOf(views);
    expect(t.owed).toBe(1500);
    expect(t.overdue).toBe(1000);
    expect(t.overdueCount).toBe(1);
    expect(t.paidCount).toBe(1);
    expect(t.interest).toBeGreaterThan(0);
  });
});
