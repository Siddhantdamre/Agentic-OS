/**
 * @jest-environment node
 *
 * recordBillingAudit writes billing_audit_log AND mirrors one billing.change
 * row into audit_events; a failed mirror must not fail the billing write.
 */
const ORG = '00000000-0000-0000-0000-0000000000aa';
const USER = '00000000-0000-0000-0000-0000000000bb';

jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(),
  getScopedClient: jest.fn(),
  scopedAuthErrorResponse: () => null,
}));

import { recordBillingAudit } from '../../app/api/billing/_lib';

function fakeClient(failAuditEvents = false) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (failAuditEvents && /INSERT INTO audit_events/.test(sql)) throw new Error('boom');
      return { rows: [] };
    }),
  };
  return { client: client as never, queries };
}

describe('recordBillingAudit mirror', () => {
  it('emits billing.change for a user-driven plan change', async () => {
    const { client, queries } = fakeClient();
    await recordBillingAudit(client, { orgId: ORG, action: 'plan_changed', actorUserId: USER, provider: 'stripe', planKey: 'growth', payload: { seats: 3 } });
    expect(queries.some((q) => /INSERT INTO billing_audit_log/.test(q.sql))).toBe(true);
    const ev = queries.find((q) => /INSERT INTO audit_events/.test(q.sql));
    expect(ev?.params[1]).toBe('billing.change');
    expect(ev?.params[2]).toBe('user');
    expect(ev?.params[3]).toBe(USER);
    expect(ev?.params[11]).toBe('plan_changed');
    expect(JSON.parse(String(ev?.params[18]))).toMatchObject({ provider: 'stripe', planKey: 'growth', seats: 3 });
  });

  it('attributes webhook-driven changes to the billing system actor', async () => {
    const { client, queries } = fakeClient();
    await recordBillingAudit(client, { orgId: ORG, action: 'dunning_entered' });
    const ev = queries.find((q) => /INSERT INTO audit_events/.test(q.sql));
    expect(ev?.params[2]).toBe('system');
    expect(ev?.params[5]).toBe('billing');
  });

  it('does not throw when the audit_events mirror fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = fakeClient(true);
    await expect(recordBillingAudit(client, { orgId: ORG, action: 'portal_opened', actorUserId: USER })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
