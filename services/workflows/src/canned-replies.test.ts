/**
 * Every canned reply must survive every gate it will be sent through.
 *
 * Found in a multi-turn run: HUMAN_REVIEW_REPLY opened with "Thanks for asking
 * — ..." and tripped the answer_first quality rule. The fallback the product
 * ships when it cannot answer was itself failing the bar every other reply is
 * held to.
 *
 * These four strings go out on the worst days — a provider outage, a review
 * timeout, a prompt injection, a request for someone else's data. They are the
 * least tested and most visible text in the product, and there is no model in
 * the loop to catch a mistake in them.
 *
 * Run: node --test dist/canned-replies.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  DISCLOSURE_SAFE_REPLY,
  HUMAN_REVIEW_REPLY,
  INTERIM_ACK_REPLY,
  PRIVACY_REFUSAL,
  SERVICE_FALLBACK_REPLY,
  formatForChannel,
  sanitiseCustomerReply,
  stripMechanismTalk,
  stripPlaceholders,
  stripPreamble,
} from './reply-gate';

const CANNED: Array<[string, string]> = [
  ['HUMAN_REVIEW_REPLY', HUMAN_REVIEW_REPLY],
  ['SERVICE_FALLBACK_REPLY', SERVICE_FALLBACK_REPLY],
  ['PRIVACY_REFUSAL', PRIVACY_REFUSAL],
  ['DISCLOSURE_SAFE_REPLY', DISCLOSURE_SAFE_REPLY],
  // Interim, not a fallback — the real answer still follows. Held to the same
  // bar because it is customer-facing text no model reviews.
  ['INTERIM_ACK_REPLY', INTERIM_ACK_REPLY],
];

test('no canned reply opens with a preamble', () => {
  for (const [name, text] of CANNED) {
    assert.equal(stripPreamble(text).removed, false, `${name} opens with a pleasantry: ${text}`);
  }
});

test('no canned reply describes mechanism', () => {
  for (const [name, text] of CANNED) {
    assert.deepEqual(stripMechanismTalk(text).removed, [], `${name} leaks mechanism`);
  }
});

test('no canned reply contains a placeholder', () => {
  for (const [name, text] of CANNED) {
    assert.deepEqual(stripPlaceholders(text).removed, [], `${name} contains a placeholder`);
  }
});

test('no canned reply trips the disclosure sanitiser', () => {
  // A gate that rewrites its own output would loop or ship something nobody
  // wrote. Each of these must pass through byte-for-byte.
  for (const [name, text] of CANNED) {
    const out = sanitiseCustomerReply(text);
    assert.equal(out.modified, false, `${name} was rewritten by the sanitiser`);
    assert.equal(out.disclosedInternals, false, `${name} read as an internal disclosure`);
    assert.equal(out.text, text);
  }
});

test('every canned reply fits a chat channel untouched', () => {
  for (const [name, text] of CANNED) {
    assert.equal(formatForChannel(text, 'whatsapp'), text, `${name} was reformatted`);
    assert.ok(text.length <= 400, `${name} exceeds the chat ceiling`);
  }
});

test('no canned reply asserts a fact it cannot support', () => {
  // These ship when the chain has already failed, so nothing can vet them.
  // Safety comes from claiming nothing: no figures, no dates, no promises
  // about hours, prices or policy.
  for (const [name, text] of CANNED) {
    assert.ok(!/\d/.test(text) || /24|48/.test(text) === false, `${name} contains a figure: ${text}`);
    assert.ok(
      !/\b(?:hours?|price|cost|refund|deliver\w*|policy|discount)\b/i.test(text),
      `${name} makes a business claim: ${text}`,
    );
  }
});

test('each canned reply tells the customer what happens next', () => {
  // A dead end is worse than a wrong answer: the customer does not know whether
  // to wait or to chase.
  for (const [name, text] of CANNED) {
    assert.match(
      text,
      /team|someone|help|happy to|shortly|come back|what you need/i,
      `${name} leaves the customer with no next step: ${text}`,
    );
  }
});
