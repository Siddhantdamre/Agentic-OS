/**
 * Leads that went quiet.
 *
 * This is the first thing the agent does unasked, so the tests are weighted
 * the way the risk is: a missed nudge costs one possible sale, a bad nudge
 * costs the account. Nearly every case below asserts that NOTHING was sent.
 *
 * Run: node --test dist/leads/quiet.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  assessLead,
  nudgeOutcome,
  summariseRevival,
  withinBusinessHours,
  localHour,
  DEFAULT_POLICY,
  type QuietLead,
} from './quiet';

const d = (iso: string) => new Date(iso);

/** A textbook chaseable lead: they asked, we answered, then silence. */
const lead = (over: Partial<QuietLead> = {}): QuietLead => ({
  conversationId: 'c1',
  lastCustomerMessageAt: d('2026-08-10T06:00:00Z'),
  lastOutboundAt: d('2026-08-10T07:00:00Z'),
  nudgesSent: 0,
  lastNudgeAt: null,
  status: 'open',
  optedOut: false,
  lastCustomerText: 'What is the price for the 3BHK in Thane?',
  ...over,
});

// 11:00 IST — inside business hours, 10 days after the customer went quiet.
const NOW = d('2026-08-20T05:30:00Z');

// ── The one case that should send ───────────────────────────────────────────

test('a genuine quiet lead is chased', () => {
  const a = assessLead(lead(), NOW);
  assert.equal(a.chase, true);
  assert.equal(a.reason, 'ready');
  assert.equal(a.nudgeNumber, 1);
  // 10 Aug 06:00 -> 20 Aug 05:30 is 9 days and 23.5 hours. Whole days elapsed,
  // floored — a lead is not "10 days quiet" half an hour early, and rounding up
  // would let every threshold fire a day sooner than the operator configured.
  assert.equal(a.quietDays, 9);
});

test('a second follow-up is allowed after the cooldown', () => {
  const a = assessLead(lead({ nudgesSent: 1, lastNudgeAt: d('2026-08-12T06:00:00Z') }), NOW);
  assert.equal(a.chase, true);
  assert.equal(a.nudgeNumber, 2);
});

// ── Everything below must NOT send ──────────────────────────────────────────

test('SILENCE: a customer who said no is never chased', () => {
  for (const text of [
    'not interested thanks',
    'We went with someone else',
    'already booked with another agent',
    'please stop contacting me',
    'remove me from your list',
    'I have changed my mind',
  ]) {
    const a = assessLead(lead({ lastCustomerText: text }), NOW);
    assert.equal(a.chase, false, `chased someone who said: "${text}"`);
    assert.equal(a.reason, 'customer_declined');
  }
});

test('SILENCE: a complaint is never chased', () => {
  for (const text of [
    'any update on my refund?',
    'the AC is still not working',
    'this is the worst service',
    'I am still waiting for the documents',
  ]) {
    const a = assessLead(lead({ lastCustomerText: text }), NOW);
    assert.equal(a.chase, false, `chased a complaint: "${text}"`);
    assert.equal(a.reason, 'complaint');
  }
});

test('SILENCE: nobody is chased a third time', () => {
  const a = assessLead(lead({ nudgesSent: 2, lastNudgeAt: d('2026-08-01T06:00:00Z') }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'already_nudged_enough');
  assert.match(a.explanation, /harassment/);
});

test('SILENCE: not twice inside the cooldown, however quiet they are', () => {
  const a = assessLead(lead({ nudgesSent: 1, lastNudgeAt: d('2026-08-18T06:00:00Z') }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'cooling_off');
});

test('SILENCE: an opted-out contact, whatever else is true', () => {
  const a = assessLead(lead({ optedOut: true }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'opted_out');
});

test('SILENCE: three days is not quiet, it is Tuesday', () => {
  const a = assessLead(lead({
    lastCustomerMessageAt: d('2026-08-19T06:00:00Z'),
    lastOutboundAt: d('2026-08-19T07:00:00Z'),
  }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'not_quiet_yet');
});

test('SILENCE: reviving a months-old thread is cold outreach, not a follow-up', () => {
  const a = assessLead(lead({
    lastCustomerMessageAt: d('2026-05-01T06:00:00Z'),
    lastOutboundAt: d('2026-05-01T07:00:00Z'),
  }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'too_old');
});

test('SILENCE: a closed conversation is not a lead', () => {
  for (const status of ['closed', 'resolved', 'won', 'lost']) {
    const a = assessLead(lead({ status }), NOW);
    assert.equal(a.chase, false, `chased a ${status} conversation`);
    assert.equal(a.reason, 'resolved');
  }
});

test('SILENCE: THE ONE THAT WOULD BE INSULTING — we are the ones who went quiet', () => {
  // Customer wrote last; we never answered. "Just following up, still
  // interested?" to someone waiting on US is the worst message here.
  const a = assessLead(lead({
    lastCustomerMessageAt: d('2026-08-10T06:00:00Z'),
    lastOutboundAt: d('2026-08-09T06:00:00Z'),
  }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'awaiting_us');
  assert.match(a.explanation, /waiting on our reply/);
});

test('SILENCE: a conversation the customer never opened is not a lead', () => {
  const a = assessLead(lead({ lastCustomerMessageAt: null }), NOW);
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'no_customer_message');
});

// ── Time of day, in the customer's world ────────────────────────────────────

test('SILENCE: nothing goes out at 3am', () => {
  // 21:30 UTC = 03:00 IST next day.
  const a = assessLead(lead(), d('2026-08-20T21:30:00Z'));
  assert.equal(a.chase, false);
  assert.equal(a.reason, 'outside_business_hours');
  assert.match(a.explanation, /3:00/);
});

test('business hours are the CUSTOMER\'s, not the server\'s', () => {
  const at0530Z = d('2026-08-20T05:30:00Z');   // 11:00 IST, 05:30 UTC
  assert.equal(withinBusinessHours(at0530Z, DEFAULT_POLICY), true, 'is 11am in Kolkata');
  assert.equal(
    withinBusinessHours(at0530Z, { ...DEFAULT_POLICY, timeZone: 'UTC' }),
    false,
    'but only 5:30am in UTC — same instant, different answer',
  );
});

test('the boundary hours are handled exactly', () => {
  const p = { ...DEFAULT_POLICY, timeZone: 'UTC', businessHours: { start: 9, end: 19 } };
  assert.equal(withinBusinessHours(d('2026-08-20T09:00:00Z'), p), true, '9am is in');
  assert.equal(withinBusinessHours(d('2026-08-20T18:59:00Z'), p), true, '18:59 is in');
  assert.equal(withinBusinessHours(d('2026-08-20T19:00:00Z'), p), false, '7pm is out');
  assert.equal(withinBusinessHours(d('2026-08-20T08:59:00Z'), p), false, '8:59am is out');
});

test('SAFETY: an unknown timezone does not silently become midnight-anywhere', () => {
  const h = localHour(d('2026-08-20T05:30:00Z'), 'Not/AZone');
  assert.equal(h, 5, 'falls back to the server hour rather than inventing one');
});

// ── Did it work? ────────────────────────────────────────────────────────────

test('a reply after the nudge counts; one before it does not', () => {
  const sent = d('2026-08-20T06:00:00Z');
  assert.equal(nudgeOutcome(sent, d('2026-08-20T07:00:00Z')), 'replied');
  assert.equal(nudgeOutcome(sent, d('2026-08-20T05:00:00Z')), 'no_reply',
    'a reply that predates the nudge was not caused by it');
  assert.equal(nudgeOutcome(sent, sent), 'no_reply', 'same instant is not causation');
  assert.equal(nudgeOutcome(sent, null), 'no_reply');
  assert.equal(nudgeOutcome(null, d('2026-08-20T07:00:00Z')), 'not_sent');
});

test('HONESTY: a rate is not quoted from a handful of nudges', () => {
  const s = summariseRevival(['replied', 'no_reply', 'replied']);
  assert.equal(s.replyRatePct, null, 'null, not 66.7% from three data points');
  assert.equal(s.sent, 3);
  assert.match(s.headline, /Too few/);
});

test('with a real sample the rate is stated plainly', () => {
  const outcomes: Array<'replied' | 'no_reply'> =
    [...Array(4).fill('replied'), ...Array(8).fill('no_reply')];
  const s = summariseRevival(outcomes);
  assert.equal(s.sent, 12);
  assert.equal(s.replied, 4);
  assert.equal(s.replyRatePct, 33.3);
  assert.match(s.headline, /would otherwise never have received/);
});

test('nothing sent yet reports nothing, not zero percent', () => {
  const s = summariseRevival([]);
  assert.equal(s.replyRatePct, null);
  assert.equal(s.sent, 0);
});

test('unsent drafts never count against the rate', () => {
  const s = summariseRevival(['not_sent', 'not_sent', 'replied']);
  assert.equal(s.sent, 1, 'proposals awaiting approval are not sends');
});
