import { humanizeId } from '../humanize-id';

describe('humanizeId', () => {
  it('turns a code into a sentence', () => {
    expect(humanizeId('agent_plans_pending')).toBe('Agent plans pending');
    expect(humanizeId('under_offer')).toBe('Under offer');
    expect(humanizeId('calendar-create-event')).toBe('Calendar create event');
  });

  it('keeps well-known short words in capitals', () => {
    expect(humanizeId('answer_faq')).toBe('Answer FAQ');
    expect(humanizeId('log_crm_note')).toBe('Log CRM note');
    expect(humanizeId('sla_breached_count')).toBe('SLA breached count');
    expect(humanizeId('refund_payment')).toBe('Refund payment');
  });

  it('drops a leading tool prefix', () => {
    expect(humanizeId('mcp.google-sheets.sheets_read')).toBe('Sheets read');
    expect(humanizeId('mcp.darex.calendar_create_event')).toBe('Calendar create event');
  });

  it('leaves ordinary text alone', () => {
    expect(humanizeId('Needs attention')).toBe('Needs attention');
    expect(humanizeId('Refund over ₹5,000')).toBe('Refund over ₹5,000');
  });

  it('never returns an empty string for a non-empty input, and never throws on junk', () => {
    expect(humanizeId('___')).toBe('___');
    expect(humanizeId('')).toBe('');
    expect(humanizeId(undefined as unknown as string)).toBe('');
    expect(humanizeId(42 as unknown as string)).toBe('42');
  });
});
