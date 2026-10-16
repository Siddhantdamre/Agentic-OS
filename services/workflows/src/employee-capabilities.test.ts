/**
 * Executor honesty rows for employee capability specs.
 * Companion to apps/dashboard/lib/__tests__/employee-capabilities.test.ts
 * (package boundary: tool modules live here).
 *
 * Calls real providers with no Nango secret so auth resolves to never-configured
 * without opening sockets. DB-backed tools are skipped with a named comment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apollo } from './tools/apollo.js';
import { googleAds } from './tools/google-ads.js';
import { googleAnalytics } from './tools/google-analytics.js';
import { googleBusinessProfile } from './tools/google-business-profile.js';
import { googleDrive } from './tools/google-drive.js';
import { googleSearchConsole } from './tools/google-search-console.js';
import { gmail } from './tools/gmail.js';
import { hubspot } from './tools/hubspot.js';
import { intercom } from './tools/intercom.js';
import { linkedin } from './tools/linkedin.js';
import { metaAds } from './tools/meta-ads.js';
import { notion } from './tools/notion.js';
import { quickbooks } from './tools/quickbooks.js';
import { salesforce } from './tools/salesforce.js';
import { stripe } from './tools/stripe.js';
import { zendesk } from './tools/zendesk.js';
import { zoho } from './tools/zoho.js';
import type { ToolModule } from './tools/shared.js';

const ORG = '00000000-0000-4000-8000-00000000c4p2';
const TS = '2026-09-27T00:00:00.000Z';

function ctx(tool: string, action: string, payload: Record<string, unknown> = {}) {
  return {
    tool,
    action,
    actionName: action,
    payload,
    orgId: ORG,
    timestamp: TS,
  };
}

function assertNotConnected(
  result: { status: string; data?: Record<string, unknown> | null; message?: string },
  tool: string,
) {
  assert.equal(result.status, 'error', `${tool} status`);
  assert.equal(result.data?.connected, false, `${tool} connected:false`);
  assert.match(String(result.message || ''), /not connected|not signed in|notConnected|GOOGLE_ADS_DEVELOPER_TOKEN/i);
  const blob = JSON.stringify(result);
  assert.doesNotMatch(blob, /fake-|INV-FAKE|invented|sample@|demo-deal/i);
  assert.equal(result.data?.contacts, undefined);
  assert.equal(result.data?.deals, undefined);
  assert.equal(result.data?.invoices, undefined);
  assert.equal(result.data?.campaigns, undefined);
}

async function withNoNango<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NANGO_SECRET_KEY;
  delete process.env.NANGO_SECRET_KEY;
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env.NANGO_SECRET_KEY = prev;
    else delete process.env.NANGO_SECRET_KEY;
  }
}

async function run(
  mod: ToolModule,
  tool: string,
  action: string,
  payload: Record<string, unknown> = {},
) {
  return withNoNango(() => mod.execute(ctx(tool, action, payload)));
}

// ── Customer Resolution connectors ─────────────────────────────────────
test('customer-resolution: hubspot_search_contacts notConnected when unsigned', async () => {
  const result = await run(hubspot, 'hubspot', 'search_contacts');
  assertNotConnected(result, 'hubspot');
});

test('customer-resolution: stripe_get_customer notConnected when unsigned', async () => {
  const result = await run(stripe, 'stripe', 'get_customer');
  assertNotConnected(result, 'stripe');
});

test('customer-resolution: stripe_create_refund notConnected when unsigned', async () => {
  const result = await run(stripe, 'stripe', 'create_refund');
  assertNotConnected(result, 'stripe');
});

test('customer-resolution: zendesk_fetch_tickets notConnected when unsigned', async () => {
  const result = await run(zendesk, 'zendesk', 'fetch_tickets');
  assertNotConnected(result, 'zendesk');
});

test('customer-resolution: intercom_create_conversation notConnected when unsigned', async () => {
  const result = await run(intercom, 'intercom', 'create_conversation');
  assertNotConnected(result, 'intercom');
});

// customer_list_open_loops / customer_list_at_risk — skip: withOrgScopedClient opens a DB socket.
// Pure honesty for missing schema is covered in tools/customer-ops.test.ts.

// ── Emma send / gmail ──────────────────────────────────────────────────
test('customer-support: gmail_send notConnected when unsigned', async () => {
  // gmail validates to/subject before auth — pass minimal payload so notConnected runs.
  const result = await run(gmail, 'gmail', 'send_email', {
    to: 'jane@acme.com',
    subject: 'demo',
    body: 'hi',
  });
  assertNotConnected(result, 'gmail');
});

test('customer-support: gmail_draft_email notConnected when unsigned', async () => {
  const result = await run(gmail, 'gmail', 'draft_email', {
    to: 'jane@acme.com',
    subject: 'demo',
    body: 'hi',
  });
  assertNotConnected(result, 'gmail');
});

// ── Finance ────────────────────────────────────────────────────────────
test('finance: stripe_create_payment_link notConnected when unsigned', async () => {
  const result = await run(stripe, 'stripe', 'create_payment_link');
  assertNotConnected(result, 'stripe');
});

test('finance: stripe_create_charge notConnected when unsigned', async () => {
  const result = await run(stripe, 'stripe', 'create_charge');
  assertNotConnected(result, 'stripe');
});

// razorpay_create_payment_link — skip: tools/razorpay.ts execute opens withOrgScopedClient
// (DB socket) before the pure notConnected branch. Cannot assert without a live pool.

test('finance: quickbooks_list_invoices notConnected when unsigned', async () => {
  const result = await run(quickbooks, 'quickbooks', 'list_invoices');
  assertNotConnected(result, 'quickbooks');
});

// billing_usage — skip: withOrgScopedClient opens a DB socket (tools/billing.ts execute).

// ── Growth / Sales prospecting ─────────────────────────────────────────
test('growth/sales: apollo_search_people notConnected when unsigned', async () => {
  const result = await run(apollo, 'apollo', 'search_people');
  assertNotConnected(result, 'apollo');
});

test('sales: linkedin_search_people notConnected when unsigned', async () => {
  const result = await run(linkedin, 'linkedin', 'search_people');
  assertNotConnected(result, 'linkedin');
});

test('sales: hubspot_create_contact notConnected when unsigned', async () => {
  // create path requires email before auth; pass one so notConnected is reached.
  const result = await run(hubspot, 'hubspot', 'create_contact', { email: 'jane@acme.com' });
  assertNotConnected(result, 'hubspot');
});

test('sales: hubspot_create_deal notConnected when unsigned', async () => {
  const result = await run(hubspot, 'hubspot', 'create_deal');
  assertNotConnected(result, 'hubspot');
});

test('sales: salesforce_list_contacts notConnected when unsigned', async () => {
  const result = await run(salesforce, 'salesforce', 'list_contacts');
  assertNotConnected(result, 'salesforce');
});

test('sales: salesforce_create_deal notConnected when unsigned', async () => {
  const result = await run(salesforce, 'salesforce', 'create_deal');
  assertNotConnected(result, 'salesforce');
});

test('sales: zoho_create_lead notConnected when unsigned', async () => {
  const result = await run(zoho, 'zoho-crm', 'create_lead');
  assertNotConnected(result, 'zoho-crm');
});

test('sales: zoho_list_deals notConnected when unsigned', async () => {
  const result = await run(zoho, 'zoho-crm', 'list_deals');
  assertNotConnected(result, 'zoho-crm');
});

// ── Marketing ──────────────────────────────────────────────────────────
test('marketing: google-ads metrics notConnected when unsigned/missing token', async () => {
  const prevTok = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  try {
    const result = await run(googleAds, 'google-ads', 'fetch_campaign_metrics');
    assertNotConnected(result, 'google-ads');
  } finally {
    if (prevTok !== undefined) process.env.GOOGLE_ADS_DEVELOPER_TOKEN = prevTok;
  }
});

test('marketing: meta-ads notConnected when unsigned', async () => {
  const result = await run(metaAds, 'meta-ads', 'fetch_campaign_metrics');
  assertNotConnected(result, 'meta-ads');
});

test('marketing: google-analytics notConnected when unsigned', async () => {
  const result = await run(googleAnalytics, 'google-analytics', 'report');
  assertNotConnected(result, 'google-analytics');
});

test('marketing: google-search-console notConnected when unsigned', async () => {
  const result = await run(googleSearchConsole, 'google-search-console', 'list_sites');
  assertNotConnected(result, 'google-search-console');
});

test('marketing: google-business-profile notConnected when unsigned', async () => {
  const result = await run(googleBusinessProfile, 'google-business-profile', 'list_locations');
  assertNotConnected(result, 'google-business-profile');
});

// ── Research Drive / Notion ────────────────────────────────────────────
test('research: google-drive notConnected when unsigned', async () => {
  const result = await run(googleDrive, 'google-drive', 'list_files');
  assertNotConnected(result, 'google-drive');
});

test('research: notion_search notConnected when unsigned', async () => {
  const result = await run(notion, 'notion', 'search');
  assertNotConnected(result, 'notion');
});

// web_search / web_extract — skip: webSearch.execute opens a network socket (Jina/Serper).
// ops_* / growth_* / daily_brief / customer-ops / billing — skip: withOrgScopedClient or DB pool.
