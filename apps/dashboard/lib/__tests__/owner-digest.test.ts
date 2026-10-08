import { buildDigest } from '../owner-digest';

const base = { answered: 0, sent: 0, waiting: 0, newInquiries: 0, showingsSoon: 0 };

describe('owner digest', () => {
  it('says plainly that nothing happened on a quiet day', () => {
    const d = buildDigest(base);
    expect(d.quiet).toBe(true);
    expect(d.lines).toEqual([]);
    expect(d.headline).toMatch(/quiet/i);
  });

  it('counts what the assistant did, with singular and plural right', () => {
    const d = buildDigest({ ...base, answered: 1, sent: 2 });
    expect(d.lines).toContain('Answered 1 customer message.');
    expect(d.lines).toContain('Sent 2 approved emails.');
    expect(d.quiet).toBe(false);
  });

  it('puts what needs the owner first', () => {
    const d = buildDigest({ ...base, answered: 12, waiting: 3, newInquiries: 2, showingsSoon: 1 });
    expect(d.lines[0]).toBe('3 approvals are waiting for you.');
    expect(d.headline).toBe('Something needs you today.');
    expect(d.lines.filter((l) => l === d.headline)).toEqual([]);
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
