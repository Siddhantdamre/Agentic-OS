/**
 * @jest-environment node
 *
 * DLQ rows carry org_id when known (visible under FORCE RLS) and never the
 * full recipient (CH-S07).
 */
const scopedQuery = jest.fn();
const poolQuery = jest.fn();
const release = jest.fn();
const getOrgScopedClient = jest.fn(async (orgId: string) => ({ client: { query: scopedQuery, release }, orgId }));
jest.mock('@/lib/db', () => ({
  pool: { query: (...args: unknown[]) => poolQuery(...args) },
  getOrgScopedClient: (orgId: string) => getOrgScopedClient(orgId),
}));

import { maskRecipient, recordFailedWebhook } from '@/lib/failed-webhooks';

beforeEach(() => {
  scopedQuery.mockReset().mockResolvedValue({ rows: [] });
  poolQuery.mockReset().mockResolvedValue({ rows: [] });
  release.mockReset();
  getOrgScopedClient.mockClear();
});

describe('maskRecipient', () => {
  it('keeps only the tail of phone numbers and the domain of emails', () => {
    expect(maskRecipient('+15551234567')).toBe('***4567');
    expect(maskRecipient('jane.doe@example.com')).toBe('j***@example.com');
    expect(maskRecipient('123')).toBe('***');
    expect(maskRecipient('')).toBe('');
  });
});

describe('recordFailedWebhook', () => {
  it('writes org_id through the org-scoped client when the org is known', async () => {
    await recordFailedWebhook({ orgId: 'org-1', channel: 'outbound:whatsapp', rawPayload: '{}', errorMessage: 'x' });
    expect(getOrgScopedClient).toHaveBeenCalledWith('org-1');
    expect(poolQuery).not.toHaveBeenCalled();
    const [sql, params] = scopedQuery.mock.calls[0];
    expect(sql).toMatch(/org_id\)/);
    expect(params[5]).toBe('org-1');
    expect(release).toHaveBeenCalled();
  });

  it('uses the pool with NULL org for unresolved payloads', async () => {
    await recordFailedWebhook({ channel: 'whatsapp', rawPayload: '{}', errorMessage: 'bad sig' });
    expect(getOrgScopedClient).not.toHaveBeenCalled();
    expect(poolQuery.mock.calls[0][1][5]).toBeNull();
  });
});
