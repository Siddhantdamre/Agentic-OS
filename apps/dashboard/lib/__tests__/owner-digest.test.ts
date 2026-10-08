import { buildDigest } from '../owner-digest';

const base = { answered: 0, sent: 0, waiting: 0, newInquiries: 0, showingsSoon: 0 };

describe('owner digest', () => {
  it('says plainly that nothing happened on a quiet day', () => {
    const d = buildDigest(base);
    expect(d.quiet).toBe(true);
    expect(d.lines).toEqual([]);
    expect(d.headline).toMatch(/quiet/i);
    expect(d.headline).not.toMatch(/needs you/i);
  });

  it('counts what the assistant did, with singular and plural right', () => {
    const d = buildDigest({ ...base, answered: 1, sent: 2 });
    expect(d.lines).toContain('Answered 1 customer message.');
    expect(d.lines).toContain('Sent 2 approved emails.');
    expect(d.quiet).toBe(false);
  });

  it('does not repeat the waiting approvals, which the Home banner already shows', () => {
    const d = buildDigest({ ...base, answered: 12, waiting: 3, newInquiries: 2, showingsSoon: 1 });
    expect(d.lines.join(' ')).not.toMatch(/approval/i);
    expect(d.lines[0]).toBe('1 showing starts in the next 24 hours.');
  });

  it('is not called quiet when something happened, even with approvals waiting', () => {
    expect(buildDigest({ ...base, waiting: 3 }).quiet).toBe(true);
    expect(buildDigest({ ...base, waiting: 3, answered: 1 }).quiet).toBe(false);
  });

  it('estimates time saved from answered messages and says it is an estimate', () => {
    const d = buildDigest({ ...base, answered: 30 });
    expect(d.minutesSaved).toBe(60);
    expect(d.savedNote).toMatch(/about 2 minutes/i);
  });

  it('never invents a saving when nothing was answered', () => {
    expect(buildDigest({ ...base, waiting: 2 }).minutesSaved).toBe(0);
  });

  it('uses no internal names', () => {
    const d = buildDigest({ answered: 5, sent: 1, waiting: 1, newInquiries: 1, showingsSoon: 1 });
    expect([d.headline, d.savedNote, ...d.lines].join(' ')).not.toMatch(/Nango|Temporal|RLS|mcp\.|work item/i);
  });
});
