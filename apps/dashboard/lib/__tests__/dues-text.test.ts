import { parseDuesPaste, draftReminder } from '../dues-text';

const today = new Date('2026-10-09T00:00:00.000Z');

describe('parseDuesPaste', () => {
  it('reads a tab-separated list pasted from a spreadsheet', () => {
    const r = parseDuesPaste('Sharma Traders\tINV-118\t1,20,000\t12/08/2026\t30\t9876543210', today);
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ buyerName: 'Sharma Traders', invoiceNo: 'INV-118', amount: 120000, creditDays: 30, buyerPhone: '9876543210' });
    expect(r.rows[0].invoiceDate).toBe('2026-08-12');
  });
  it('accepts pipes, rupee signs and ISO dates, and skips a header row and blank lines', () => {
    const r = parseDuesPaste('Buyer | Invoice | Amount | Date\n\nPatel Motors | 55 | ₹ 45,500.50 | 2026-09-01', today);
    expect(r.problems).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ buyerName: 'Patel Motors', amount: 45500.5, invoiceDate: '2026-09-01', creditDays: null });
  });
  it('reads comma-separated lines when the amount has no commas', () => {
    const r = parseDuesPaste('Rao Steel, 77, 80000, 03-07-2026, 45', today);
    expect(r.rows[0]).toMatchObject({ buyerName: 'Rao Steel', amount: 80000, invoiceDate: '2026-07-03', creditDays: 45 });
  });
  it('says plainly which line is wrong and why, and still reads the good ones', () => {
    const r = parseDuesPaste('Good Co\t1\t1000\t01/09/2026\nBad Co\t2\tabc\t01/09/2026\nNo Date Co\t3\t500\tsoon', today);
    expect(r.rows.map((x) => x.buyerName)).toEqual(['Good Co']);
    expect(r.problems).toEqual([
      'Line 2: I could not read the amount "abc".',
      'Line 3: I could not read the date "soon". Use day/month/year, for example 12/08/2026.',
    ]);
  });
  it('refuses an invoice dated in the future', () => {
    const r = parseDuesPaste('Future Co\t1\t1000\t01/01/2027', today);
    expect(r.rows).toEqual([]);
    expect(r.problems[0]).toMatch(/Line 1: .*in the future/);
  });
  it('refuses a zero or negative amount', () => {
    expect(parseDuesPaste('Zero Co\t1\t0\t01/09/2026', today).problems[0]).toMatch(/amount/);
  });
  it('caps one paste at 200 lines', () => {
    const many = Array.from({ length: 205 }, (_, i) => `Buyer ${i}\t${i}\t100\t01/09/2026`).join('\n');
    const r = parseDuesPaste(many, today);
    expect(r.rows).toHaveLength(200);
    expect(r.problems.at(-1)).toMatch(/200/);
  });
});

describe('draftReminder', () => {
  const base = { buyerName: 'Sharma Traders', invoiceNo: 'INV-118', amount: 120000, dueDate: '2026-09-01', daysLate: 38, businessName: 'Gupta Auto Parts', interest: 0, msmeRegistered: false, payLink: null as string | null };

  it('is warm and short for a friendly reminder, and offers an easy way out if it is already paid', () => {
    const t = draftReminder({ ...base, tone: 'friendly', daysLate: 3 });
    expect(t).toMatch(/Sharma Traders/);
    expect(t).toMatch(/INV-118/);
    expect(t).toMatch(/₹1,20,000/);
    expect(t).toMatch(/already (paid|done|sent)/i);
    expect(t).toMatch(/Gupta Auto Parts/);
    expect(t.length).toBeLessThan(420);
  });
  it('includes the payment link only when there is one', () => {
    expect(draftReminder({ ...base, tone: 'friendly' })).not.toMatch(/https?:/);
    expect(draftReminder({ ...base, tone: 'friendly', payLink: 'https://rzp.io/l/abc' })).toMatch(/https:\/\/rzp\.io\/l\/abc/);
  });
  it('states the delay plainly when firm', () => {
    expect(draftReminder({ ...base, tone: 'firm', daysLate: 14 })).toMatch(/14 days/);
  });
  it('mentions the statutory interest only for a registered small supplier, and as a figure to confirm', () => {
    const reg = draftReminder({ ...base, tone: 'formal', interest: 4170.5, msmeRegistered: true });
    expect(reg).toMatch(/₹4,170\.50/);
    expect(reg).toMatch(/MSMED Act/);
    const notReg = draftReminder({ ...base, tone: 'formal', interest: 4170.5, msmeRegistered: false });
    expect(notReg).not.toMatch(/MSMED/);
    expect(notReg).not.toMatch(/4,170/);
  });
  it('never threatens, never blames and never uses legal-sounding warnings in the first two tones', () => {
    for (const tone of ['friendly', 'firm'] as const) {
      expect(draftReminder({ ...base, tone })).not.toMatch(/legal action|court|police|fraud|cheat|immediately|final notice/i);
    }
  });
  it('keeps the whole formal Hindi reminder in Hindi, interest sentence included', () => {
    const t = draftReminder({ ...base, tone: 'formal', interest: 4170.5, msmeRegistered: true, language: 'hinglish' });
    expect(t).toMatch(/MSMED Act/);
    expect(t).toMatch(/₹4,170\.50/);
    expect(t).not.toMatch(/we are entitled|registered small supplier we/i);
  });
  it('can be written in Hindi (Roman script) too', () => {
    const t = draftReminder({ ...base, tone: 'friendly', language: 'hinglish' });
    expect(t).toMatch(/Namaste/);
    expect(t).toMatch(/₹1,20,000/);
  });
});
