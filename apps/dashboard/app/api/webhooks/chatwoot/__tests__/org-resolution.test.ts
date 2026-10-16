/**
 * @jest-environment node
 *
 * Which tenant does an inbound Chatwoot message belong to?
 *
 * `orgs` is FORCE ROW LEVEL SECURITY (migration 097). A pooled connection with
 * no org context sees ZERO rows in it — measured on a running stack: 4 orgs as
 * owner, 0 visible to darex_app. So a route that runs `SELECT ... FROM orgs`
 * on the bare pool can never identify a tenant; only SECURITY DEFINER
 * resolver functions can. The fake database below behaves the same way, so
 * these tests fail for the reason the real stack fails: not because of a mock.
 */
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET_A = 'secret-of-org-a';
const SECRET_B = 'secret-of-org-b';

let inboxMap: Record<string, string> = {};
const rawOrgReads: string[] = [];

const query = jest.fn(async (sql: string, params: unknown[] = []) => {
  const s = String(sql);
  if (/resolve_org_by_webhook_secret/i.test(s)) {
    if (params[0] === SECRET_A) return { rows: [{ id: ORG_A }] };
    if (params[0] === SECRET_B) return { rows: [{ id: ORG_B }] };
    return { rows: [{ id: null }] };
  }
  if (/org_resolve_by_id_and_secret/i.test(s)) {
    if (params[0] === ORG_A && params[1] === SECRET_A) return { rows: [{ id: ORG_A }] };
    if (params[0] === ORG_B && params[1] === SECRET_B) return { rows: [{ id: ORG_B }] };
    return { rows: [{ id: null }] };
  }
  if (/\bFROM\s+orgs\b/i.test(s)) {
    // What the database does to a bare pool connection: the policy hides every row.
    rawOrgReads.push(s.replace(/\s+/g, ' ').trim());
    return { rows: [] };
  }
  return { rows: [] };
});

const getOrgScopedClient = jest.fn(async (_orgId: string): Promise<never> => {
  throw new Error('STOP_AFTER_RESOLUTION');
});

jest.mock('@/lib/db', () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  getOrgScopedClient: (orgId: string) => getOrgScopedClient(orgId),
}));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));
jest.mock('@/lib/webhook-crypto', () => ({
  assertChatwootWebhookSignature: () => ({ ok: true, status: 200 }),
}));
jest.mock('@/lib/inbound-agent', () => ({
  employeePersonaText: jest.fn(),
  fireInboundAgent: jest.fn(),
  parseToolAllowlist: jest.fn(),
}));
jest.mock('@/lib/channel-outbound', () => ({ replyTargetFromChannelMeta: jest.fn() }));
jest.mock('@/lib/rate-limit', () => ({
  denyWebhookIfLimited: () => null,
  isRateLimitError: () => false,
  responseFromRateLimit: jest.fn(),
}));
jest.mock('@/lib/channel-normalize', () => ({
  normalizeChannelKey: (c: string) => c,
  upsertChatwootInboxMap: jest.fn(),
  resolveOrgByChatwootInbox: jest.fn(async (account: unknown, inboxId: number | null) =>
    inboxId == null ? null : inboxMap[`${account}:${inboxId}`] ?? null
  ),
}));

import { POST } from '../route';

function payload(over: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    contact_id: 'contact-1',
    content: 'hello',
    message_type: 'incoming',
    ...over,
  };
}

async function send(qs: string, headers: Record<string, string> = {}, body: Record<string, unknown> = payload()) {
  const res = await POST(
    new Request(`http://dash.test/api/webhooks/chatwoot${qs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
  return res;
}

/** Resolved = the route moved on and asked for a client scoped to that org. */
async function resolvedOrg(qs: string, headers: Record<string, string> = {}, body?: Record<string, unknown>) {
  getOrgScopedClient.mockClear();
  let res: Response | null = null;
  try {
    res = await send(qs, headers, body);
  } catch {
    /* STOP_AFTER_RESOLUTION surfaces here */
  }
  const asked = getOrgScopedClient.mock.calls.map((c) => (c as unknown[])[0]);
  return { orgId: (asked[0] as string | undefined) ?? null, status: res?.status ?? null };
}

beforeEach(() => {
  inboxMap = {};
  rawOrgReads.length = 0;
  query.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('Chatwoot webhook — resolving the tenant', () => {
  it('resolves the org from "Authorization: Bearer <that org\'s secret>"', async () => {
    const r = await resolvedOrg('', { authorization: `Bearer ${SECRET_A}` });
    expect(r.orgId).toBe(ORG_A);
  });

  it('resolves the org from the per-tenant URL ?org_id=<id>&token=<secret>', async () => {
    const r = await resolvedOrg(`?org_id=${ORG_A}&token=${SECRET_A}`);
    expect(r.orgId).toBe(ORG_A);
  });

  it('resolves the org from X-Darex-Org-Id plus ?token=<secret>', async () => {
    const r = await resolvedOrg(`?token=${SECRET_A}`, { 'x-darex-org-id': ORG_A });
    expect(r.orgId).toBe(ORG_A);
  });

  it('resolves the org from the Chatwoot inbox map', async () => {
    inboxMap['7:42'] = ORG_C;
    const r = await resolvedOrg('', {}, payload({ inbox_id: 42, account: { id: 7 } }));
    expect(r.orgId).toBe(ORG_C);
  });

  it('never reads `orgs` on the bare pool (forced RLS hides every row from it)', async () => {
    await resolvedOrg(`?org_id=${ORG_A}&token=${SECRET_A}`);
    await resolvedOrg(`?token=${SECRET_A}`, { 'x-darex-org-id': ORG_A });
    await resolvedOrg('', { authorization: 'Bearer wrong' });
    expect(rawOrgReads).toEqual([]);
  });

  it('refuses a valid org id paired with the wrong secret', async () => {
    const r = await resolvedOrg(`?org_id=${ORG_A}&token=nope`);
    expect(r.orgId).toBeNull();
    expect(r.status).toBe(400);
  });

  it("refuses org B's id with org A's secret — a secret opens only its own org", async () => {
    const r = await resolvedOrg(`?org_id=${ORG_B}&token=${SECRET_A}`);
    expect(r.orgId).toBeNull();
    expect(r.status).toBe(400);
  });

  it('refuses a request that carries no credential and maps to no inbox', async () => {
    const r = await resolvedOrg('');
    expect(r.orgId).toBeNull();
    expect(r.status).toBe(400);
  });

  it('answers 400, not a database error, when org_id is not a UUID', async () => {
    query.mockClear();
    const r = await resolvedOrg(`?org_id=not-a-uuid&token=${SECRET_A}`);
    expect(r.orgId).toBeNull();
    expect(r.status).toBe(400);
    // The malformed id must be stopped before it reaches a ::uuid cast in SQL.
    expect(query.mock.calls.some((c) => /org_resolve_by_id_and_secret/i.test(String(c[0])))).toBe(false);
  });

  it('does not let a FAILED credential fall through to the inbox map named in the body', async () => {
    // The caller chooses account/inbox ids in the body. Presenting org B's id with
    // org A's token must not quietly land the message in org C because C owns that inbox.
    inboxMap['7:42'] = ORG_C;
    const r = await resolvedOrg(`?org_id=${ORG_B}&token=${SECRET_A}`, {}, payload({ inbox_id: 42, account: { id: 7 } }));
    expect(r.orgId).toBeNull();
    expect(r.status).toBe(400);
  });
});
