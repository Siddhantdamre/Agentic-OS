import { describeHeldAction, reasonText, relativeTime, expiresIn, canApproveTogether, type HeldAction } from '../approval-view';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const email = (over: Partial<HeldAction> = {}): HeldAction => ({
  id: 'a1',
  employeeRole: 'Customer Support',
  employeeName: 'Emma',
  createdAt: '2026-10-07T11:55:00Z',
  expiresAt: '2026-10-08T11:55:00Z',
  requiredApprovals: 1,
  approvals: [],
  payload: {
    tool: 'gmail', action: 'send_email', reasonCode: 'confirm_class',
    summary: 'Send email "About your enquiry" to priya@example.test',
    payload: { to: 'priya@example.test', subject: 'About your enquiry', body: 'Hi Priya,\nThe Baner flat is free on Saturday at 11am.' },
  },
  ...over,
});

describe('describeHeldAction', () => {
  it('says who wants to do what, to whom, and shows the message itself so it can be read before it is sent', () => {
    const v = describeHeldAction(email(), NOW);
    expect(v.title).toBe('Send email "About your enquiry" to priya@example.test');
    expect(v.kind).toBe('email');
    expect(v.who).toBe('Emma');
    expect(v.body).toBe('Hi Priya,\nThe Baner flat is free on Saturday at 11am.');
    expect(v.details).toEqual([{ label: 'To', value: 'priya@example.test' }, { label: 'Subject', value: 'About your enquiry' }]);
    expect(v.ageText).toBe('5 min ago');
    expect(v.expiresText).toBe('Expires in 1 day');
    expect(v.money).toBe(false);
  });

  it('falls back to the employee role, then to a plain phrase, when no name is known', () => {
    expect(describeHeldAction(email({ employeeName: null }), NOW).who).toBe('Customer Support');
    expect(describeHeldAction(email({ employeeName: null, employeeRole: null }), NOW).who).toBe('An AI employee');
  });

  it('builds a sentence itself when the stored summary is missing, never "decision"', () => {
    const a = email();
    delete (a.payload as Record<string, unknown>).summary;
    expect(describeHeldAction(a, NOW).title).toBe('Send email "About your enquiry" to priya@example.test');
    const bare = describeHeldAction({ id: 'x', payload: { tool: 'hubspot', action: 'update_contact', payload: {} } }, NOW);
    expect(bare.title).toMatch(/hubspot/i);
    expect(bare.title.toLowerCase()).not.toBe('decision');
  });

  it('treats a refund or a charge as money: marked, two people if the row says so, and never in a "approve all"', () => {
    const refund = describeHeldAction({
      id: 'r1', employeeRole: 'Finance', requiredApprovals: 2, approvals: [{ userId: 'u1', at: '2026-10-07T11:00:00Z' }],
      payload: { tool: 'stripe', action: 'create_refund', reasonCode: 'confirm_class', summary: 'Refund to customer', payload: { chargeId: 'ch_1', amount: 4000, reason: 'requested_by_customer' } },
    }, NOW);
    expect(refund.money).toBe(true);
    expect(refund.kind).toBe('refund');
    expect(refund.approvalsNeeded).toBe(2);
    expect(refund.approvalsGiven).toBe(1);
    expect(refund.needsText).toBe('1 of 2 approvals given');
    expect(canApproveTogether(refund)).toBe(false);
    expect(canApproveTogether(describeHeldAction(email(), NOW))).toBe(true);
  });

  it('shows a calendar booking and a chat message in their own words', () => {
    const cal = describeHeldAction({ id: 'c1', payload: { tool: 'google-calendar', action: 'create_event', payload: { summary: 'Showing: Baner 2 BHK', startTime: '2026-10-10T11:00:00+05:30', attendees: 'priya@example.test' } } }, NOW);
    expect(cal.kind).toBe('calendar');
    expect(cal.details.map((d) => d.label)).toEqual(['Summary', 'Start time', 'Attendees']);
    const wa = describeHeldAction({ id: 'w1', payload: { tool: 'whatsapp', action: 'send_message', payload: { to: '+919900000000', message: 'Your showing is at 11am' } } }, NOW);
    expect(wa.kind).toBe('message');
    expect(wa.body).toBe('Your showing is at 11am');
    expect(wa.details).toEqual([{ label: 'To', value: '+919900000000' }]);
  });

  it('never shows a credential, and keeps a long message to a readable length', () => {
    const v = describeHeldAction({ id: 'o1', payload: { tool: 'zendesk', action: 'update_ticket', payload: { ticketId: '42', api_key: 'sk_live_123', authorization: 'Bearer x', status: 'solved' } } }, NOW);
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/sk_live_123|Bearer x/);
    expect(v.details.map((d) => d.label)).toEqual(['Ticket id', 'Status']);
    const long = describeHeldAction(email({ payload: { tool: 'gmail', action: 'send_email', payload: { to: 'a@b.co', subject: 's', body: 'x'.repeat(2000) } } }), NOW);
    expect(long.body!.length).toBeLessThanOrEqual(601);
    expect(long.body!.endsWith('…')).toBe(true);
  });

  it('shows an html message as text', () => {
    const v = describeHeldAction(email({ payload: { tool: 'gmail', action: 'send_email', payload: { to: 'a@b.co', subject: 's', html: '<p>Hello&nbsp;<b>Priya</b></p><script>alert(1)</script>' } } }), NOW);
    expect(v.body).toBe('Hello Priya');
  });

  it('survives a row with nothing usable in it', () => {
    const v = describeHeldAction({ id: 'z', payload: null }, NOW);
    expect(v.title).toBe('An action is waiting for your OK');
    expect(v.details).toEqual([]);
    expect(v.body).toBeNull();
  });
});

describe('reasonText', () => {
  it('explains in plain words why it was held', () => {
    expect(reasonText('confirm_class', 'email')).toBe('Sending a message to a customer always needs your OK.');
    expect(reasonText('confirm_class', 'refund')).toBe('Moving money always needs your OK.');
    expect(reasonText('skill_tier', 'email')).toBe('This employee is not trusted to do this on their own yet.');
    expect(reasonText('rollout_stage', 'calendar')).toBe('Your team is at a trust level where this needs your OK.');
    expect(reasonText('org_rule_requires_approval', 'other')).toBe('Your workspace rules ask for your OK on this.');
    expect(reasonText(undefined, 'other')).toBe('Your workspace rules ask for your OK on this.');
  });
});

describe('time words', () => {
  it('says how long ago and how long is left, in plain units', () => {
    expect(relativeTime('2026-10-07T11:59:40Z', NOW)).toBe('just now');
    expect(relativeTime('2026-10-07T11:00:00Z', NOW)).toBe('1 h ago');
    expect(relativeTime('2026-10-05T12:00:00Z', NOW)).toBe('2 days ago');
    expect(relativeTime(null, NOW)).toBe('');
    expect(expiresIn('2026-10-07T14:00:00Z', NOW)).toBe('Expires in 2 h');
    expect(expiresIn('2026-10-07T12:20:00Z', NOW)).toBe('Expires in 20 min');
    expect(expiresIn('2026-10-07T11:00:00Z', NOW)).toBe('Expired');
    expect(expiresIn(null, NOW)).toBeNull();
  });
});

describe('finalNote', () => {
  it('warns before approving that a sent email or message cannot be taken back', () => {
    expect(describeHeldAction(email(), NOW).finalNote).toBe('Once sent, this cannot be taken back.');
  });
  it('warns that money moves as soon as it is approved', () => {
    const refund = describeHeldAction({ id: 'r', payload: { tool: 'stripe', action: 'refund_payment', payload: { amount: 500 } } }, NOW);
    expect(refund.finalNote).toBe('Money moves as soon as you approve.');
  });
  it('says nothing for a change that can simply be changed again', () => {
    const rec = describeHeldAction({ id: 'x', payload: { tool: 'hubspot', action: 'update_contact', payload: {} } }, NOW);
    expect(rec.finalNote).toBeNull();
  });
});

