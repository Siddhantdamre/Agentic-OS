/**
 * Post-reply HITL: classify on tool IDENTITY, never on tool OUTPUT.
 *
 * Third instance of one bug. isPayRisk/isSendRisk/isSignRisk look for bare
 * tokens — `charge`, `payout`, `payment-link`, `gmail-send` — which are tool
 * identifiers. Run over free text they match ordinary English, and a tool's
 * `result` is free text.
 *
 * The consequence was measured: the agent retrieved "outside Bengaluru a
 * delivery charge of 1200 rupees applies", the word `charge` in its own
 * research tripped the payment gate, the reply was held, and the customer got
 * an acknowledgement instead of the answer. Better research made the agent MORE
 * likely to be gagged.
 *
 * Run: node --test dist/hitl-tool-blob.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { inboundRequiresHitlWait } from './inbound-hitl';

// ── Retrieved knowledge must never trip the gate ────────────────────────────

test('the two replies held in the completion run now go out', () => {
  // Both verbatim: the seeded knowledge the agent correctly retrieved.
  const held = [
    {
      id: 'outside_city',
      userMessage: 'I live outside Bengaluru. Is there a delivery charge?',
      reply: 'Yes — outside Bengaluru a delivery charge of ₹1,200 applies.',
      result:
        'Delivery times — In-stock items are delivered within 3 to 5 working days. '
        + 'We deliver across Karnataka; outside Bengaluru a delivery charge of 1200 rupees applies.',
    },
    {
      id: 'cancellation',
      userMessage: 'If I change my mind about an order, can I cancel it?',
      reply: 'Yes. Orders can be cancelled free of charge within 48 hours; after that a 15% restocking fee applies.',
      result:
        'Cancellation policy — Orders can be cancelled free of charge within 48 hours '
        + 'of placing them. After 48 hours a restocking fee of 15% applies.',
    },
  ];
  for (const c of held) {
    const verdict = inboundRequiresHitlWait({
      userMessage: c.userMessage,
      reply: c.reply,
      executedSteps: [{ step: 1, action: 'Search knowledge', result: c.result }],
    });
    assert.equal(verdict.wait, false, `${c.id} still held: ${JSON.stringify(verdict.classes)}`);
  }
});

test('money words inside retrieved policy text are inert', () => {
  const results = [
    'Standard installation is charged at 8% of order value.',
    'We do not charge for delivery within Bengaluru city limits.',
    'An initial design consultation costs 2500 rupees.',
    'Delivery charges are non-refundable.',
    'A restocking fee of 15% applies after 48 hours.',
  ];
  for (const result of results) {
    const verdict = inboundRequiresHitlWait({
      userMessage: 'How much is it?',
      reply: 'Here is the answer.',
      executedSteps: [{ step: 1, action: 'Search knowledge', result }],
    });
    assert.equal(verdict.wait, false, `wrongly held on: ${result}`);
  }
});

// ── Real side-effecting tools must STILL be caught ──────────────────────────

test('a real payment tool still requires approval', () => {
  // Identity is what marks a side effect. These must all still gate.
  const tools = [
    { step: 1, toolUsed: 'razorpay', action: 'Execute Tool: razorpay', result: 'ok' },
    { step: 1, toolUsed: 'stripe', action: 'Execute Tool: stripe', result: 'ok' },
    { step: 1, tool: 'payment-link', action: 'Create payment link', result: 'created' },
    { step: 1, action: 'Execute Tool: payout', result: 'done' },
  ];
  for (const step of tools) {
    const verdict = inboundRequiresHitlWait({
      userMessage: 'sort the balance please',
      reply: 'Done.',
      executedSteps: [step],
    });
    assert.equal(verdict.wait, true, `payment tool escaped: ${JSON.stringify(step)}`);
    assert.ok(verdict.classes.includes('pay'));
  }
});

test('a real signing tool still requires approval', () => {
  for (const t of ['docusign', 'leegality']) {
    const verdict = inboundRequiresHitlWait({
      userMessage: 'send the contract',
      reply: 'Sent.',
      executedSteps: [{ step: 1, toolUsed: t, action: `Execute Tool: ${t}`, result: 'ok' }],
    });
    assert.equal(verdict.wait, true, `signing tool escaped: ${t}`);
  }
});

test('a real outbound-send tool still requires approval', () => {
  for (const t of ['gmail-send', 'slack-send', 'twilio-send']) {
    const verdict = inboundRequiresHitlWait({
      userMessage: 'let them know',
      reply: 'Sent.',
      usedTools: [t],
    });
    assert.equal(verdict.wait, true, `send tool escaped: ${t}`);
  }
});

test('a read-only tool never gates, whatever it returns', () => {
  // gmail_fetch reading an invoice email full of money words must stay silent.
  const verdict = inboundRequiresHitlWait({
    userMessage: 'any word from the supplier?',
    reply: 'Yes, they replied yesterday.',
    executedSteps: [{
      step: 1,
      toolUsed: 'gmail_fetch',
      action: 'Execute Tool: gmail_fetch',
      result: 'Subject: Invoice — a charge of 5000 rupees, payment link enclosed, payout pending.',
    }],
  });
  assert.equal(verdict.wait, false, `read-only tool gated: ${JSON.stringify(verdict.classes)}`);
});
