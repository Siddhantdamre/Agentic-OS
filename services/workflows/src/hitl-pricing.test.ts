/**
 * HITL classification of inbound customer messages.
 *
 * This gate is two-sided and BOTH sides are dangerous:
 *
 *   Over-trigger → the workflow parks in waiting_approval for a signal that
 *   never comes, and the customer gets permanent silence with no error logged.
 *   That is what happened: "Do you charge extra for installation?" matched the
 *   bare token `charge` in a matcher written for Stripe tool names, and four of
 *   twelve questions in the completion run hung forever.
 *
 *   Under-trigger → a real instruction to move money executes with no human
 *   approval. Strictly worse.
 *
 * So every loosening below is paired with a test proving the real action still
 * gets caught.
 *
 * Run: node --test dist/hitl-pricing.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { inboundRequiresHitlWait } from './inbound-hitl';

const waits = (userMessage: string) => inboundRequiresHitlWait({ userMessage }).wait;

// ── Must NOT wait: questions about money ────────────────────────────────────

test('the four questions that hung in the completion run now answer', () => {
  // Verbatim from the run. Each sat in waiting_approval indefinitely.
  const hung = [
    'If I change my mind about an order, can I cancel it?',
    'How much do you charge for a design consultation?',
    'I live outside Bengaluru. Is there a delivery charge?',
    'Do you charge extra for installation?',
  ];
  for (const q of hung) {
    assert.equal(waits(q), false, `still parks on a pricing question: ${q}`);
  }
});

test('ordinary commercial questions never wait', () => {
  // These are the most common things a business is ever asked. If any of them
  // parks, the product is unusable for its core use case.
  const questions = [
    'What are your charges for delivery?',
    'How much does installation cost?',
    'Is there a cancellation fee?',
    'What is your refund policy?',
    'How long does a refund take to come through?',
    'Do I get charged for a second visit?',
    'What payment methods do you accept?',
    'Can I pay on delivery?',
    'Is the consultation free?',
    'How much would a custom wardrobe be?',
  ];
  for (const q of questions) {
    assert.equal(waits(q), false, `wrongly parked: ${q}`);
  }
});

// ── Must STILL wait: instructions to act ────────────────────────────────────

test('a real instruction to move money still requires approval', () => {
  const actions = [
    'Please send a payment link for 5000 rupees.',
    'Create a charge for the balance.',
    'Send a razorpay link to the customer.',
    'Create a payout to the vendor.',
    'Send a stripe payment to close this.',
  ];
  for (const a of actions) {
    assert.equal(waits(a), true, `payment action escaped approval: ${a}`);
  }
});

test('a customer claiming they already paid still requires approval', () => {
  // The risk here is the agent marking an invoice settled on the customer's
  // word alone.
  for (const m of ["I've paid the invoice", 'payment sent yesterday', 'just paid']) {
    assert.equal(waits(m), true, `pay claim escaped approval: ${m}`);
  }
});

test('signing intent still requires approval', () => {
  const signing = [
    'Please sign the agreement and send it back.',
    'Send me the docusign envelope.',
    'I have the contract to sign.',
  ];
  for (const s of signing) {
    assert.equal(waits(s), true, `signing escaped approval: ${s}`);
  }
});

test('outbound email on the customer\'s behalf still requires approval', () => {
  for (const s of ['Email the client the quote', 'Please email them the proposal']) {
    assert.equal(waits(s), true, `send escaped approval: ${s}`);
  }
});

test('"send me the details" is a request, not an outbound send', () => {
  // The classic false positive: the customer asking to RECEIVE something.
  for (const s of ['Send me the details', 'Can you send me your price list?']) {
    assert.equal(waits(s), false, `wrongly parked: ${s}`);
  }
});

test('greetings and empty input never wait', () => {
  for (const s of ['Hi there!', 'Hello', '', '   ']) {
    assert.equal(waits(s), false, `wrongly parked: ${JSON.stringify(s)}`);
  }
});
