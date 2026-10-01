import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundRequiresHitlWait, resolveInboundHitlGate, runInboundDirectFallback } from './inbound-hitl.js';

test('greetings do not wait', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'hi',
    reply: 'Hello! How can I help you today?',
    executedSteps: [{ step: 1, action: 'Final Response Synthesis', result: 'Generated reply' }],
    usedTools: [],
  });
  assert.equal(result.wait, false);
  assert.deepEqual(result.classes, []);
});

test('read-only gmail fetch does not wait', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'any new mail?',
    reply: 'You have 2 unread emails.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: gmail_fetch', toolUsed: 'gmail_fetch', result: 'tool executed' },
    ],
    usedTools: ['gmail_fetch'],
  });
  assert.equal(result.wait, false);
});

test('gmail draft does not wait', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'draft a follow-up',
    reply: 'I drafted a follow-up. Approve it in Gmail when ready.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: gmail_draft_email', toolUsed: 'gmail_draft_email', result: 'drafted' },
    ],
    usedTools: ['gmail_draft_email'],
  });
  assert.equal(result.wait, false);
});

test('gmail_send waits as send', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'email the client the quote',
    reply: 'Sent the quote to Priya.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: gmail_send', toolUsed: 'gmail_send', result: 'args: to=priya@' },
    ],
    usedTools: ['gmail_send'],
  });
  assert.equal(result.wait, true);
  assert.ok(result.classes.includes('send'));
});

test('razorpay tool waits as pay', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'send a payment link',
    reply: 'Here is the payment link.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: razorpay', toolUsed: 'razorpay', result: 'payment-link created' },
    ],
    usedTools: ['razorpay'],
  });
  assert.equal(result.wait, true);
  assert.equal(result.classes[0], 'pay');
});

test('docusign tool waits as sign', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'send the lease to sign',
    reply: 'Envelope created. Please sign the agreement.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: docusign', toolUsed: 'mcp.darex.docusign', result: 'envelope sent' },
    ],
    usedTools: ['mcp.darex.docusign'],
  });
  assert.equal(result.wait, true);
  assert.ok(result.classes.includes('sign'));
});

test('whatsapp channel echo is not a send-class wait', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'thanks',
    reply: 'You are welcome. Your showing is Tuesday at 3pm.',
    executedSteps: [
      { step: 1, action: 'Execute Tool: whatsapp_send', toolUsed: 'whatsapp_send', result: 'sent' },
    ],
    usedTools: ['whatsapp_send'],
  });
  assert.equal(result.wait, false);
});

test('user-message send intent waits before any tools', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'email the client the quote',
    reply: '',
    executedSteps: [],
    usedTools: [],
  });
  assert.equal(result.wait, true);
  assert.ok(result.classes.includes('send'));
});

test('user-message pay intent waits before any tools', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'send a payment link',
    reply: '',
    executedSteps: [],
    usedTools: [],
  });
  assert.equal(result.wait, true);
  assert.equal(result.classes[0], 'pay');
});

test('user-message sign intent waits before any tools', () => {
  const result = inboundRequiresHitlWait({
    userMessage: 'send the lease to sign',
    reply: '',
    executedSteps: [],
    usedTools: [],
  });
  assert.equal(result.wait, true);
  assert.ok(result.classes.includes('sign'));
});

test('greeting gate skips wait and allows the turn', () => {
  const gate = resolveInboundHitlGate({
    userMessage: 'hi',
    reply: 'Hello! How can I help you today?',
    executedSteps: [],
    usedTools: [],
  });
  assert.equal(gate.wait, false);
  assert.equal(gate.allowSideEffectTools, true);
  assert.equal(gate.allowCustomerReply, true);
  assert.equal(gate.conversationNeedsAttention, false);
});

test('send/pay/sign does not execute tools before approval', () => {
  const send = resolveInboundHitlGate({ userMessage: 'email the client the quote' });
  assert.equal(send.wait, true);
  assert.equal(send.allowSideEffectTools, false);
  assert.equal(send.allowCustomerReply, false);
  assert.equal(send.conversationNeedsAttention, true);

  const pay = resolveInboundHitlGate({ userMessage: 'send a payment link' });
  assert.equal(pay.wait, true);
  assert.equal(pay.allowSideEffectTools, false);
  assert.equal(pay.classes[0], 'pay');

  const sign = resolveInboundHitlGate({ userMessage: 'send the lease to sign' });
  assert.equal(sign.wait, true);
  assert.equal(sign.allowSideEffectTools, false);
  assert.ok(sign.classes.includes('sign'));
});

test('reject does not send', () => {
  const gate = resolveInboundHitlGate({
    userMessage: 'email the client the quote',
    decision: 'rejected',
  });
  assert.equal(gate.allowSideEffectTools, false);
  assert.equal(gate.allowCustomerReply, false);
  assert.equal(gate.conversationNeedsAttention, true);
});

test('approve then executes/sends', () => {
  const gate = resolveInboundHitlGate({
    userMessage: 'email the client the quote',
    decision: 'approved',
  });
  assert.equal(gate.wait, false);
  assert.equal(gate.allowSideEffectTools, true);
  assert.equal(gate.allowCustomerReply, true);
});

test('Temporal-down fallback: send/pay/sign does not execute send', async () => {
  const execute = async () => {
    throw new Error('gmail_send must not run');
  };
  const queued: string[][] = [];
  for (const msg of ['email the client the quote', 'send a payment link', 'send the lease to sign']) {
    const result = await runInboundDirectFallback(msg, {
      execute,
      queueHitl: async (classes) => {
        queued.push(classes);
      },
    });
    assert.equal(result.kind, 'queued_hitl');
    if (result.kind !== 'queued_hitl') continue;
    assert.ok(result.classes.length > 0);
  }
  assert.equal(queued.length, 3);
  assert.ok(queued[0].includes('send'));
  assert.equal(queued[1][0], 'pay');
  assert.ok(queued[2].includes('sign'));
});

test('Temporal-down fallback: greeting still executes', async () => {
  let executed = false;
  const result = await runInboundDirectFallback('hi', {
    execute: async () => {
      executed = true;
      return 'hello';
    },
    queueHitl: async () => {
      throw new Error('greeting must not queue HITL');
    },
  });
  assert.equal(result.kind, 'executed');
  assert.equal(executed, true);
  if (result.kind !== 'executed') return;
  assert.equal(result.result, 'hello');
});

test('Temporal-down fallback: read and draft still execute', async () => {
  for (const msg of ['any new mail?', 'draft a follow-up']) {
    let executed = false;
    const result = await runInboundDirectFallback(msg, {
      execute: async () => {
        executed = true;
        return 'ok';
      },
      queueHitl: async () => {
        throw new Error(`${msg} must not queue HITL`);
      },
    });
    assert.equal(result.kind, 'executed');
    assert.equal(executed, true);
  }
});

test('Temporal-down fallback: queueHitl throw still does not execute send', async () => {
  let executed = false;
  await assert.rejects(
    () =>
      runInboundDirectFallback('email the client the quote', {
        execute: async () => {
          executed = true;
          return 'sent';
        },
        queueHitl: async () => {
          throw new Error('persist failed');
        },
      }),
    /persist failed/
  );
  assert.equal(executed, false);
});
