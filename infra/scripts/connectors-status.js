#!/usr/bin/env node
'use strict';
/**
 * WHAT THE AI EMPLOYEES CANNOT REACH YET, AND WHAT EACH KEY WOULD UNLOCK.
 *
 * 95 tools are wired to the agent over MCP and 47 tool modules implement a real
 * `execute`. Most reach outside the business and need an account credential only
 * the business owner can obtain. A few do not, and which few was worth checking
 * rather than assuming — database_query and metrics read the tenant's own data,
 * and web_extract turned out to read the open internet with no key at all
 * (r.jina.ai answers keyless; verified HTTP 200 with real page text, while
 * s.jina.ai returns 401). So the agent can already READ any page it is pointed
 * at. It cannot go FIND pages, because search is the half that needs the key.
 *
 * Measured, not assumed: Nango is healthy with 0 provider configs and 0
 * connections, and the environment holds exactly one external credential
 * (the model provider). So the honest state is:
 *
 *     the hands are built, the arms are wired, and almost nothing is plugged in.
 *
 * ── WHY THIS IS ORDERED BY LEVERAGE ───────────────────────────────────────
 * Seventeen Google tools share ONE Nango config key (`google`). Connecting a
 * single Google account turns on Gmail, Calendar, Drive, Docs, Sheets, Slides,
 * Forms, Chat, Meet, Contacts, Tasks, Ads, Analytics, Search Console, Business
 * Profile and Cloud. Nothing else in the list comes close, so it is first.
 *
 * Usage: node infra/scripts/connectors-status.js
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/**
 * `auth` is what the business owner must actually obtain:
 *   oauth   an OAuth app (client id + secret) registered with the provider,
 *           then a per-tenant consent through Nango
 *   key     a plain API key or token pasted into the environment
 *   none    already works — reads the tenant's own data
 */
const PROVIDERS = [
  { key: 'google', auth: 'oauth', tools: 17, unlocks: 'Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Chat, Meet, Contacts, Tasks, Ads, Analytics, Search Console, Business Profile, Cloud',
    get: 'console.cloud.google.com — one OAuth client, then add it to Nango as provider key "google"' },
  { key: 'whatsapp', auth: 'key', tools: 2, env: ['META_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
    unlocks: 'whatsapp_send — the channel your customers actually use',
    get: 'developers.facebook.com — WhatsApp Business API number + permanent token' },
  // Measured, not assumed, and it has changed twice.
  //
  // These were once one row needing JINA_API_KEY. Then it was measured that
  // r.jina.ai answers keyless and s.jina.ai returns 401, so they were split:
  // the agent could READ any URL it was given and could not DISCOVER one.
  //
  // Search now falls through Jina and Brave to DuckDuckGo and Wikipedia, which
  // need no credential (tools/search-providers.ts), so BOTH halves work with
  // nothing bought. This row said "needs JINA_API_KEY" for a while after that
  // stopped being true — the sixth copy of the same stale claim, and a reminder
  // that an operator-facing status page is a claim like any other and goes
  // stale like any other.
  { key: 'web_extract', auth: 'none', tools: 1,
    unlocks: 'web_extract — read any page the agent is pointed at',
    get: 'already working — Jina Reader answers without a key' },
  { key: 'web_search', auth: 'none', tools: 2,
    unlocks: 'web_search + deep_research — finding pages instead of being handed them',
    get: 'already working — DuckDuckGo and Wikipedia need no key. '
      + 'A Brave key (2,000 free queries/month) removes the burst throttling.' },
  { key: 'hubspot', auth: 'oauth', tools: 2, unlocks: 'contact create/update — the CRM most SMBs already run', get: 'developers.hubspot.com' },
  { key: 'razorpay', auth: 'key', tools: 1, env: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
    unlocks: 'payment links — the collections story', get: 'dashboard.razorpay.com — API keys' },
  { key: 'twilio', auth: 'key', tools: 2, env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
    unlocks: 'SMS send/list', get: 'console.twilio.com' },
  { key: 'maps', auth: 'key', tools: 2, env: ['GOOGLE_MAPS_API_KEY'],
    unlocks: 'geocode / reverse geocode — "which of your listings is near this?"', get: 'console.cloud.google.com — Maps API key' },
  { key: 'stripe', auth: 'oauth', tools: 3, unlocks: 'payment links, customers', get: 'dashboard.stripe.com' },
  { key: 'slack', auth: 'oauth', tools: 1, unlocks: 'internal notifications', get: 'api.slack.com/apps' },
  { key: 'notion', auth: 'oauth', tools: 3, unlocks: 'pages, search', get: 'notion.so/my-integrations' },
  { key: 'zendesk', auth: 'oauth', tools: 3, unlocks: 'ticket read/create/update', get: 'your Zendesk admin' },
  { key: 'intercom', auth: 'oauth', tools: 3, unlocks: 'conversations, replies', get: 'developers.intercom.com' },
  { key: 'shopify', auth: 'oauth', tools: 2, unlocks: 'products, orders', get: 'shopify.dev' },
  { key: 'github', auth: 'oauth', tools: 3, unlocks: 'repos, issues', get: 'github.com/settings/developers' },
  { key: 'salesforce', auth: 'oauth', tools: 3, unlocks: 'contacts, leads', get: 'your Salesforce admin' },
  { key: 'zoho', auth: 'oauth', tools: 3, unlocks: 'contacts, leads — common in India', get: 'api-console.zoho.in' },
  { key: 'docusign', auth: 'oauth', tools: 3, unlocks: 'envelopes — signing', get: 'developers.docusign.com' },
  { key: 'leegality', auth: 'key', tools: 3, env: ['LEEGALITY_API_TOKEN', 'LEEGALITY_PROFILE_ID'],
    unlocks: 'Indian e-sign — Aadhaar eSign for agreements', get: 'leegality.com' },
  { key: 'quickbooks', auth: 'oauth', tools: 3, unlocks: 'customers, invoices', get: 'developer.intuit.com' },
  { key: 'meta-ads', auth: 'key', tools: 1, env: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID'],
    unlocks: 'ad performance — where the leads come from', get: 'developers.facebook.com' },
  { key: 'database_query', auth: 'none', tools: 1, unlocks: 'the tenant\'s own data, RLS-scoped', get: 'already working' },
  { key: 'metrics', auth: 'none', tools: 2, unlocks: 'the tenant\'s own KPIs', get: 'already working' },
];

const has = (name) => {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
};

(async () => {
  await db.connect();
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  CONNECTORS — what the AI employees can and cannot reach             ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  let live = 0;
  let liveTools = 0;
  let blockedTools = 0;

  try {
    // Nango is the OAuth broker. No configs means no OAuth provider can be
    // connected at all, however many tools are implemented behind them.
    let nangoConfigs = 0;
    let nangoConns = 0;
    try {
      const n = new Client({
        host: process.env.DB_HOST || '127.0.0.1',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_RESOLVER_USER || 'darex',
        password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
        database: 'nango',
      });
      await n.connect();
      nangoConfigs = Number((await n.query('SELECT COUNT(*)::int AS n FROM nango._nango_configs')).rows[0].n);
      nangoConns = Number((await n.query('SELECT COUNT(*)::int AS n FROM nango._nango_connections')).rows[0].n);
      await n.end();
    } catch { /* nango unreachable; reported as 0 */ }

    console.log(`  OAuth broker : ${nangoConfigs} provider config(s), ${nangoConns} connection(s)`);
    if (nangoConfigs === 0) {
      console.log('                 no OAuth provider can connect until a client id/secret is registered\n');
    }

    const channels = (await db.query(
      `SELECT channel_type, status, COUNT(*)::int AS n FROM channels GROUP BY 1,2 ORDER BY n DESC`)).rows;
    if (channels.length) {
      console.log('  Channels     : ' + channels.map((c) => `${c.channel_type}=${c.status}(${c.n})`).join('  '));
    }

    console.log('\n  ── Ordered by how many tools each one turns on ──\n');
    console.log(`  ${'PROVIDER'.padEnd(16)}${'AUTH'.padEnd(7)}${'TOOLS'.padEnd(7)}STATUS`);

    // Value order, hand-set. Tool count is a vendor artefact, not importance.
    const VALUE = ['google', 'whatsapp', 'web_extract', 'web_search', 'razorpay', 'maps', 'leegality',
      'hubspot', 'twilio', 'meta-ads', 'zoho', 'stripe', 'docusign', 'quickbooks',
      'salesforce', 'zendesk', 'intercom', 'shopify', 'slack', 'notion', 'github',
      'database_query', 'metrics'];
    const rank = (k) => { const i = VALUE.indexOf(k); return i < 0 ? 99 : i; };
    for (const p of PROVIDERS.sort((a, b) => rank(a.key) - rank(b.key))) {
      let status;
      if (p.auth === 'none') { status = 'WORKING'; live += 1; liveTools += p.tools; }
      else if (p.auth === 'key') {
        const missing = (p.env || []).filter((e) => !has(e));
        if (missing.length === 0) { status = 'WORKING'; live += 1; liveTools += p.tools; }
        else { status = `needs ${missing.join(', ')}`; blockedTools += p.tools; }
      } else {
        status = nangoConfigs > 0 ? 'provider registered, awaiting consent' : 'needs an OAuth app';
        blockedTools += p.tools;
      }
      const mark = status === 'WORKING' ? ' ok ' : '    ';
      console.log(`  ${mark}${p.key.padEnd(16)}${p.auth.padEnd(7)}${String(p.tools).padEnd(7)}${status}`);
    }

    console.log(`\n  ${liveTools} tool(s) work today. ${blockedTools} are waiting on a credential.\n`);

    // ── The shopping list, in the order that buys the most ────────────────
    console.log('  ── What to get, in order ──\n');
    const todo = PROVIDERS.sort((a, b) => rank(a.key) - rank(b.key)).filter((p) => {
      if (p.auth === 'none') return false;
      if (p.auth === 'key') return (p.env || []).some((e) => !has(e));
      return true;
    }).slice(0, 5);

    todo.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.key}  (+${p.tools} tools)`);
      console.log(`     ${p.unlocks}`);
      console.log(`     where: ${p.get}\n`);
    });

    console.log('  Everything else can wait until a customer asks for it.\n');
  } finally {
    await db.end().catch(() => {});
  }
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
