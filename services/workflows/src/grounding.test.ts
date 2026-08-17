/**
 * Grounding tests.
 *
 * The product promise is "you can trust the numbers". These assert that a
 * fabricated figure cannot reach a customer, and — just as important — that
 * ordinary correct replies are not blocked by an over-eager checker. A checker
 * people learn to ignore protects nobody.
 *
 * Run: node --test dist/grounding.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  extractClaims,
  verifyClaims,
  evaluateGrounding,
  buildGroundingFixPrompt,
} from './grounding';

/** Realistic evidence: a tool result the agent actually retrieved. */
const EVIDENCE = `
[database_query] rows:
{"invoice_ref":"INV-1042","amount":45000,"status":"overdue","due_date":"2026-03-01"}
{"invoice_ref":"INV-1043","amount":12500,"status":"paid","due_date":"2026-02-14"}
count: 2 overdue invoices
`;

test('catches a fabricated money amount', () => {
  const v = evaluateGrounding(
    'You have one overdue invoice for ₹98,750 — shall I chase it?',
    EVIDENCE
  );
  assert.strictEqual(v.allow, false, 'invented amount must be blocked');
  assert.ok(v.offending.some((c) => c.kind === 'money'));
});

test('allows an amount that appears in the retrieved data', () => {
  const v = evaluateGrounding('INV-1042 is overdue for ₹45,000. Shall I chase it?', EVIDENCE);
  assert.strictEqual(v.allow, true, `blocked a correct reply: ${v.reason}`);
});

test('number formatting differences do not cause false alarms', () => {
  // Evidence says 45000; the reply writes ₹45,000. Same fact.
  for (const written of ['₹45,000', '45000', 'INR 45,000', '₹45000']) {
    const v = evaluateGrounding(`The balance is ${written}.`, EVIDENCE);
    assert.strictEqual(v.allow, true, `false alarm on ${written}: ${v.reason}`);
  }
});

test('catches a fabricated invoice reference', () => {
  const v = evaluateGrounding('I have chased INV-9999 for you.', EVIDENCE);
  assert.strictEqual(v.allow, false);
  assert.ok(v.offending.some((c) => c.kind === 'identifier'));
});

test('allows a real invoice reference', () => {
  const v = evaluateGrounding('I have chased INV-1043.', EVIDENCE);
  assert.strictEqual(v.allow, true, v.reason);
});

test('QUALITY: an honest no-data answer is never blocked', () => {
  // The behaviour we WANT: admitting ignorance must always be cheaper than
  // inventing. If this were blocked, the agent would learn to fabricate.
  const v = evaluateGrounding(
    "I could not find any invoices for that customer. Would you like me to search by email instead?",
    EVIDENCE
  );
  assert.strictEqual(v.allow, true, v.reason);
});

test('QUALITY: ordinary prose with no figures passes cleanly', () => {
  const v = evaluateGrounding(
    'Thanks for getting in touch — I will look into this and come back to you shortly.',
    ''
  );
  assert.strictEqual(v.allow, true);
  assert.strictEqual(v.report.claims.length, 0);
  assert.match(v.reason, /no checkable/i);
});

test('QUALITY: small ordinals in prose are not treated as facts', () => {
  // "the 2 options below" must not require evidence, or every reply trips.
  const v = evaluateGrounding('Here are 2 options you could take.', '');
  assert.strictEqual(v.allow, true, v.reason);
});

test('SAFETY: hedging an invented number is still a fabrication', () => {
  const v = evaluateGrounding('You owe approximately ₹98,750 in total.', EVIDENCE);
  assert.strictEqual(v.allow, false, '"approximately" must not launder an invented figure');
});

test('percentages are checked', () => {
  const bad = evaluateGrounding('Your conversion rate improved by 47%.', EVIDENCE);
  assert.strictEqual(bad.report.unsupported.some((c) => c.kind === 'percentage'), true);
});

test('dates are checked against evidence', () => {
  const good = evaluateGrounding('It was due on 2026-03-01.', EVIDENCE);
  assert.strictEqual(good.allow, true, good.reason);
  const bad = evaluateGrounding('It was due on 2027-11-19.', EVIDENCE);
  assert.strictEqual(bad.report.unsupported.length > 0, true);
});

test('money is extracted once, not double-counted as a bare number', () => {
  const claims = extractClaims('The total is ₹45,000 today.');
  const money = claims.filter((c) => c.kind === 'money');
  const numbers = claims.filter((c) => c.kind === 'number');
  assert.strictEqual(money.length, 1);
  assert.strictEqual(numbers.length, 0, '₹45,000 must not also count as a bare number');
});

test('claims carry context for a human reviewer', () => {
  const claims = extractClaims('After review, the outstanding balance is ₹45,000 as of today.');
  assert.ok(claims[0].context.includes('outstanding balance'));
});

test('empty evidence blocks any specific figure', () => {
  // The dangerous default: with nothing retrieved, no figure is defensible.
  const v = evaluateGrounding('You have ₹45,000 outstanding.', '');
  assert.strictEqual(v.allow, false);
});

test('grounding score is reported over all checkable claims', () => {
  const report = verifyClaims(
    extractClaims('INV-1042 for ₹45,000 and INV-9999 for ₹98,750.'),
    EVIDENCE
  );
  assert.strictEqual(report.claims.length, 4);
  assert.strictEqual(report.supported.length, 2);
  assert.strictEqual(report.unsupported.length, 2);
  assert.ok(Math.abs(report.groundingScore - 0.5) < 1e-9);
  assert.strictEqual(report.fullyGrounded, false);
});

test('policy can relax the threshold without dropping critical kinds', () => {
  // Even at a 50% threshold, an invented AMOUNT is still refused.
  const v = evaluateGrounding('You owe ₹98,750 across 2 invoices.', EVIDENCE, {
    minGroundingScore: 0.5,
  });
  assert.strictEqual(v.allow, false, 'money must stay critical regardless of threshold');
});

test('the fix prompt forbids hedging and names the offending values', () => {
  const v = evaluateGrounding('You owe ₹98,750.', EVIDENCE);
  const prompt = buildGroundingFixPrompt('You owe ₹98,750.', v);
  assert.match(prompt, /98,750/);
  assert.match(prompt, /approximately/i, 'must explicitly forbid hedging');
  assert.match(prompt, /remove the specific figure/i);
});

test('SAFETY: never throws on odd input', () => {
  for (const draft of ['', '   ', '₹', '###', '....', '2026-13-45']) {
    assert.doesNotThrow(() => evaluateGrounding(draft, EVIDENCE));
  }
});
