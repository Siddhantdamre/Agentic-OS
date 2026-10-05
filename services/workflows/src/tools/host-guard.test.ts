import test from 'node:test';
import assert from 'node:assert/strict';

// The Nango client reads these when shared.js is first loaded, so set them first.
process.env.NANGO_SECRET_KEY = 'test-nango-key';
process.env.NANGO_HOST = 'http://nango.test';
delete process.env.SHOPIFY_SHOP_DOMAIN;
delete process.env.ZENDESK_SUBDOMAIN;

import { decideHost, normaliseShopifyHost, normaliseZendeskSubdomain, pickTrusted } from './host-guard.js';

/**
 * Two layers, both pinned here.
 *
 * 1. The pure host rules. Every string below is a way to make
 *    `https://${x}.zendesk.com/...` or `https://${x}/admin/...` land somewhere
 *    other than the workspace's own account.
 * 2. The tools themselves, with `fetch` replaced by a recorder. The claim that
 *    matters is not "the helper works" but "no request carrying a token ever
 *    leaves for a host the workspace does not own" — so the recorder sees every
 *    call, including the one to Nango, and the assertions are about the rest.
 */

// ── The pure rules ───────────────────────────────────────────────────────

test('a real store reference normalises to <label>.myshopify.com', () => {
  assert.equal(normaliseShopifyHost('acme.myshopify.com'), 'acme.myshopify.com');
  assert.equal(normaliseShopifyHost('  ACME.MyShopify.com  '), 'acme.myshopify.com');
  assert.equal(normaliseShopifyHost('https://acme.myshopify.com/'), 'acme.myshopify.com');
  assert.equal(normaliseShopifyHost('acme'), 'acme.myshopify.com');
  assert.equal(normaliseShopifyHost('a-b-c-1'), 'a-b-c-1.myshopify.com');
});

test('a real Zendesk reference normalises to the bare label', () => {
  assert.equal(normaliseZendeskSubdomain('acme'), 'acme');
  assert.equal(normaliseZendeskSubdomain('ACME.zendesk.com'), 'acme');
  assert.equal(normaliseZendeskSubdomain('https://acme.zendesk.com/'), 'acme');
});

const HOSTILE = [
  'attacker.example',
  'attacker.example/x?',
  'attacker.example#',
  'attacker.example\\@',
  'acme@attacker.example',
  'acme.myshopify.com.attacker.example',
  'acme.myshopify.com@attacker.example',
  'acme.myshopify.com:8443',
  'acme.myshopify.com/admin',
  'acme.myshopify.com?x=1',
  'acme.myshopify.com#',
  'acme.myshopify.com\n.attacker.example',
  'acme.myshopify.com\u0000',
  'acme．myshopify.com', // fullwidth full stop
  '127.0.0.1',
  '169.254.169.254',
  '[::1]',
  '-acme.myshopify.com',
  'acme-.myshopify.com',
  'a'.repeat(64) + '.myshopify.com',
  '',
  '   ',
];

test('no hostile string survives as a Shopify host', () => {
  for (const h of HOSTILE) assert.equal(normaliseShopifyHost(h), null, `Shopify accepted: ${JSON.stringify(h)}`);
});

test('no hostile string survives as a Zendesk subdomain', () => {
  const zd = HOSTILE.concat(['acme.zendesk.com.attacker.example', 'acme.attacker.example', 'a.b', 'acme/../x']);
  for (const h of zd) assert.equal(normaliseZendeskSubdomain(h), null, `Zendesk accepted: ${JSON.stringify(h)}`);
});

test('a bare label is only ever resolved UNDER the provider\'s own domain', () => {
  // `localhost` is a legal store name, not a route to the local machine: the
  // tool appends the provider suffix, so the request still goes to Shopify/Zendesk.
  assert.equal(normaliseShopifyHost('localhost'), 'localhost.myshopify.com');
  assert.equal(normaliseZendeskSubdomain('localhost'), 'localhost');
});

test('non-strings never normalise', () => {
  for (const v of [undefined, null, 0, 42, {}, [], ['acme'], true]) {
    assert.equal(normaliseShopifyHost(v), null);
    assert.equal(normaliseZendeskSubdomain(v), null);
  }
});

const rule = (trusted: string | null, requested: unknown) =>
  decideHost({
    provider: 'Shopify', field: 'shopDomain', trusted, requested,
    normalise: normaliseShopifyHost, missingMessage: 'MISSING',
  });

test('the connection wins when the model names nothing', () => {
  assert.deepEqual(rule('acme.myshopify.com', undefined), { ok: true, host: 'acme.myshopify.com' });
  assert.deepEqual(rule('acme.myshopify.com', ''), { ok: true, host: 'acme.myshopify.com' });
});

test('the model may name the workspace\'s own store', () => {
  assert.deepEqual(rule('acme.myshopify.com', 'ACME'), { ok: true, host: 'acme.myshopify.com' });
});

test('the model may NOT retarget a workspace that already has a store', () => {
  const d = rule('acme.myshopify.com', 'other.myshopify.com');
  assert.equal(d.ok, false);
  assert.match(d.message, /does not match/);
});

test('with nothing recorded, a model-written host is never trusted, even a valid-looking one', () => {
  // Anyone can register other.myshopify.com for free, so a syntactically valid host proves nothing.
  const d = rule(null, 'other.myshopify.com');
  assert.equal(d.ok, false);
  assert.match(d.message, /No Shopify account is recorded/);
  assert.equal(rule(null, 'attacker.example').ok, false);
  assert.equal(rule(null, undefined).message, 'MISSING');
});

test('pickTrusted: first recorded value wins, and a recorded but unusable one is an error, not a fall-through', () => {
  assert.deepEqual(pickTrusted([undefined, '', 'acme.myshopify.com', 'other.myshopify.com'], normaliseShopifyHost), { trusted: 'acme.myshopify.com', invalid: false });
  assert.deepEqual(pickTrusted([undefined, null, ''], normaliseShopifyHost), { trusted: null, invalid: false });
  // A vanity domain recorded for the workspace must NOT fall through to the deployment default.
  assert.deepEqual(pickTrusted(['shop.example.com', 'default.myshopify.com'], normaliseShopifyHost), { trusted: null, invalid: true });
  const d = decideHost({ provider: 'Shopify', field: 'shopDomain', trusted: null, trustedInvalid: true, requested: undefined, normalise: normaliseShopifyHost, missingMessage: 'MISSING' });
  assert.equal(d.ok, false);
  assert.match(d.message, /not a valid Shopify host/);
});

test('a rejected value is never echoed back', () => {
  const d = rule('acme.myshopify.com', 'attacker.example/<script>');
  assert.equal(d.ok, false);
  assert.doesNotMatch(d.message, /attacker|script/);
});

// ── The tools, with fetch recorded ───────────────────────────────────────

type Call = { url: string; init: any };
const calls: Call[] = [];
let connection: any = null;
const realFetch = globalThis.fetch;

function install(conn: any, shopReply: () => Response = () => new Response(JSON.stringify({ products: [], tickets: [], orders: [] }), { status: 200 })) {
  calls.length = 0;
  connection = conn;
  (globalThis as any).fetch = async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('http://nango.test/')) return new Response(JSON.stringify(connection), { status: connection ? 200 : 404 });
    return shopReply();
  };
}
test.after(() => { (globalThis as any).fetch = realFetch; });

/** Every request that is not the Nango lookup: the ones that could carry a token. */
const outbound = () => calls.filter((c) => !c.url.startsWith('http://nango.test/'));
// The Nango lookup is cached for a minute per connection id (org + provider), so a test that needs a
// DIFFERENT connection shape must use its own org id or it silently sees the previous test's.
const ctx = (tool: string, action: string, payload: Record<string, any>, orgId = '00000000-0000-4000-8000-0000000000a1') => ({
  tool, action, actionName: action, payload, orgId, timestamp: '2026-09-29T00:00:00.000Z',
});

const shopifyConn = (config: Record<string, any> = { shop: 'acme.myshopify.com' }) => ({
  credentials: { access_token: 'SHPAT-secret' }, connection_config: config, metadata: {},
});
const zendeskConn = (config: Record<string, any> = { subdomain: 'acme' }) => ({
  credentials: { access_token: 'ZD-secret' }, connection_config: config, metadata: {},
});

test('shopify: a payload host that is not a Shopify store gets no request and no token', async () => {
  const { shopify } = require('./shopify.js');
  install(shopifyConn());
  const r = await shopify.execute(ctx('shopify', 'fetch_products', { shopDomain: 'attacker.example' }));
  assert.equal(r.status, 'error');
  assert.equal(outbound().length, 0, 'a request left for a host the workspace does not own');
  assert.doesNotMatch(JSON.stringify(r), /SHPAT-secret/);
});

test('shopify: a valid but DIFFERENT store is refused when the connection has its own', async () => {
  const { shopify } = require('./shopify.js');
  install(shopifyConn());
  const r = await shopify.execute(ctx('shopify', 'fetch_orders', { shopDomain: 'someone-else.myshopify.com' }));
  assert.equal(r.status, 'error');
  assert.match(r.message, /does not match/);
  assert.equal(outbound().length, 0);
});

test('shopify: with no payload the connection\'s own store is used, and redirects are refused', async () => {
  const { shopify } = require('./shopify.js');
  install(shopifyConn());
  const r = await shopify.execute(ctx('shopify', 'fetch_products', {}));
  assert.equal(r.status, 'executed');
  assert.equal(outbound().length, 1);
  assert.match(outbound()[0].url, /^https:\/\/acme\.myshopify\.com\/admin\//);
  assert.equal(outbound()[0].init.headers['X-Shopify-Access-Token'], 'SHPAT-secret');
  assert.equal(outbound()[0].init.redirect, 'error');
});

test('shopify: Nango\'s own `subdomain` key is understood as the trusted store', async () => {
  const { shopify } = require('./shopify.js');
  install(shopifyConn({ subdomain: 'acme' }));
  const r = await shopify.execute(ctx('shopify', 'fetch_products', { shopDomain: 'attacker.example' }));
  assert.equal(r.status, 'error');
  assert.equal(outbound().length, 0);
});

test('shopify: a workspace with no recorded store cannot be pointed anywhere by the model', async () => {
  const { shopify } = require('./shopify.js');
  install(shopifyConn({}));
  const r = await shopify.execute(ctx('shopify', 'fetch_products', { shopDomain: 'acme' }, '00000000-0000-4000-8000-0000000000b1'));
  assert.equal(r.status, 'error');
  assert.equal(outbound().length, 0, 'no request, so no token, leaves for a store the model chose');
});

test('shopify: a recorded but unusual store value is an error, not a silent fall-through to the env default', async () => {
  const { shopify } = require('./shopify.js');
  const prev = process.env.SHOPIFY_SHOP_DOMAIN;
  process.env.SHOPIFY_SHOP_DOMAIN = 'deployment-default.myshopify.com';
  try {
    install(shopifyConn({ shop: 'shop.vanity-domain.example' }));
    const r = await shopify.execute(ctx('shopify', 'fetch_products', {}, '00000000-0000-4000-8000-0000000000b2'));
    assert.equal(r.status, 'error');
    assert.equal(outbound().length, 0, "this workspace's token must not go to the deployment's default store");
  } finally {
    if (prev === undefined) delete process.env.SHOPIFY_SHOP_DOMAIN; else process.env.SHOPIFY_SHOP_DOMAIN = prev;
  }
});

test('zendesk: every way of turning the subdomain into another host is refused', async () => {
  const { zendesk } = require('./zendesk.js');
  for (const evil of ['attacker.example/x?', 'attacker.example#', 'acme.zendesk.com.attacker.example', 'a@attacker.example']) {
    install(zendeskConn());
    const r = await zendesk.execute(ctx('zendesk', 'fetch_tickets', { subdomain: evil }));
    assert.equal(r.status, 'error', evil);
    assert.equal(outbound().length, 0, `a request left for ${evil}`);
    assert.doesNotMatch(JSON.stringify(r), /ZD-secret/);
  }
});

test('zendesk: create and update are held to the same rule', async () => {
  const { zendesk } = require('./zendesk.js');
  for (const [action, extra] of [['create_support_ticket', { subject: 's' }], ['update_ticket', { ticketId: 1, status: 'solved' }]] as const) {
    install(zendeskConn());
    const r = await zendesk.execute(ctx('zendesk', action, { subdomain: 'attacker.example/x?', ...extra }));
    assert.equal(r.status, 'error', action);
    assert.equal(outbound().length, 0, action);
  }
});

test('zendesk: the connected account is used, with the token, and no redirect is followed', async () => {
  const { zendesk } = require('./zendesk.js');
  install(zendeskConn());
  const r = await zendesk.execute(ctx('zendesk', 'fetch_tickets', {}));
  assert.equal(r.status, 'executed');
  assert.equal(outbound().length, 1);
  assert.match(outbound()[0].url, /^https:\/\/acme\.zendesk\.com\/api\/v2\/tickets\.json/);
  assert.equal(outbound()[0].init.headers.Authorization, 'Bearer ZD-secret');
  assert.equal(outbound()[0].init.redirect, 'error');
});

test('zendesk: a different valid account is refused when the connection has its own', async () => {
  const { zendesk } = require('./zendesk.js');
  install(zendeskConn());
  const r = await zendesk.execute(ctx('zendesk', 'fetch_tickets', { subdomain: 'competitor' }));
  assert.equal(r.status, 'error');
  assert.match(r.message, /does not match/);
  assert.equal(outbound().length, 0);
});

// ── Why `redirect: 'error'` is on every authenticated request ────────────

test('zendesk: with no recorded account the model cannot name one, and no token leaves', async () => {
  const { zendesk } = require('./zendesk.js');
  install(zendeskConn({}));
  const r = await zendesk.execute(ctx('zendesk', 'fetch_tickets', { subdomain: 'attacker' }, '00000000-0000-4000-8000-0000000000b3'));
  assert.equal(r.status, 'error');
  assert.match(r.message, /No Zendesk account is recorded/);
  assert.equal(outbound().length, 0);
});

test('fetch forwards a custom credential header across a cross-origin redirect (and redirect:error stops it)', async () => {
  // Pins the behaviour the tools' comments rely on. Node's fetch strips
  // `Authorization` on a cross-origin redirect but NOT `X-Shopify-Access-Token`,
  // so without redirect:'error' a redirect from a provider (an open redirect, a
  // renamed store) would carry the token to whatever host it names. If a future
  // Node strips custom headers too, this test fails and the reasoning can be
  // revisited rather than silently going stale.
  const http = await import('node:http');
  const seen: Array<Record<string, any>> = [];
  const evil = http.createServer((req, res) => { seen.push(req.headers); res.end('{}'); });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  const good = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(evil.address() as any).port}/x` });
    res.end();
  });
  await new Promise<void>((r) => good.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(good.address() as any).port}/admin`;
  const headers = { 'X-Shopify-Access-Token': 'SHPAT-secret', Authorization: 'Bearer ZD-secret' };
  try {
    await realFetch(url, { headers });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]['x-shopify-access-token'], 'SHPAT-secret', 'custom header was forwarded');
    assert.equal(seen[0]['authorization'], undefined, 'Authorization is stripped by fetch itself');

    seen.length = 0;
    await assert.rejects(() => realFetch(url, { headers, redirect: 'error' }));
    assert.equal(seen.length, 0, 'redirect:error must not reach the redirect target');
  } finally {
    good.close();
    evil.close();
  }
});
