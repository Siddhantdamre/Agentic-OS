import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from './tool-definitions.js';

// Set before any module that reads it at load time (tools/shared.ts).
process.env.NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY || 'test-nango-secret';

async function parseToolArguments(...args: Parameters<typeof import('./local-turn.js')['parseToolArguments']>) {
  const mod = await import('./local-turn.js');
  return mod.parseToolArguments(...args);
}

const def = (name: string) => {
  const found = TOOLS.find((t) => t.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
};

test('malformed JSON is an error, never an empty-args call', async () => {
  const res = await parseToolArguments(def('stripe_create_payment_link'), '{"amount": 50');
  assert.equal(res.ok, false);
  if ('error' in res) assert.match(res.error, /not valid JSON/);
});

test('missing required field is rejected before execution', async () => {
  const res = await parseToolArguments(def('stripe_create_payment_link'), '{}');
  assert.equal(res.ok, false);
  if ('error' in res) assert.match(res.error, /amount/);
});

test('wrong type is rejected', async () => {
  const res = await parseToolArguments(def('gmail_send'), { to: 'a@b.co', subject: 1, body: 'x' });
  assert.equal(res.ok, false);
});

test('valid args pass; org_id and nulls are dropped; extra keys pass through', async () => {
  const res = await parseToolArguments(def('gmail_send'), {
    org_id: 'spoofed',
    to: 'a@b.co',
    subject: 'Hi',
    body: 'x',
    cc: null,
    extra: 'kept',
  });
  assert.equal(res.ok, true);
  if ('args' in res) {
    assert.equal(res.args.org_id, undefined);
    assert.equal('cc' in res.args, false);
    assert.equal(res.args.extra, 'kept');
    assert.equal(res.args.to, 'a@b.co');
  }
});

test('empty string arguments are treated as {}', async () => {
  const res = await parseToolArguments(def('gmail_fetch'), '');
  assert.equal(res.ok, true);
});

test('stripe payment link without amount never reaches Stripe', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/connection/')) {
      return new Response(JSON.stringify({ credentials: { access_token: 'sk_test_x' } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { stripe } = await import('./tools/stripe.js');
    const res = await stripe.execute({
      tool: 'stripe',
      action: 'create_payment_link',
      actionName: 'create_payment_link',
      payload: {},
      orgId: '00000000-0000-4000-8000-0000000000a1',
      timestamp: new Date().toISOString(),
    });
    assert.equal(res.status, 'error');
    assert.match(res.message, /amount/);
    assert.equal(calls.some((u) => u.includes('api.stripe.com')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
