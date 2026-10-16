/**
 * @jest-environment node
 *
 * BIZ-S02: connector connect / disconnect / BYOK / config / test / ping are
 * owner+admin only. Route-level check on POST /api/integrations too.
 */

const queryMock = jest.fn();
const releaseMock = jest.fn();

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    client: { query: queryMock, release: releaseMock },
    orgId: '00000000-0000-0000-0000-0000000000aa',
    userId: '00000000-0000-0000-0000-0000000000bb',
  })),
  getOrgScopedClient: jest.fn(),
  scopedAuthErrorResponse: () => null,
}));

import { denyUnlessConnectorManager } from '../connector-rbac';
import type { PoolClient } from 'pg';

function clientWithRole(role: string): PoolClient {
  return { query: jest.fn(async () => ({ rows: [{ role }] })) } as unknown as PoolClient;
}

describe('denyUnlessConnectorManager', () => {
  it.each(['owner', 'admin'])('allows %s', async (role) => {
    expect(await denyUnlessConnectorManager(clientWithRole(role), 'u')).toBeNull();
  });

  it.each(['member', 'auditor', 'billing'])('forbids %s', async (role) => {
    const res = await denyUnlessConnectorManager(clientWithRole(role), 'u');
    expect(res?.status).toBe(403);
  });
});

describe('POST /api/integrations RBAC', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  it('rejects an auditor disconnecting gmail before touching Nango or channels', async () => {
    queryMock.mockImplementation(async (sql: string) =>
      /FROM users/.test(sql) ? { rows: [{ role: 'auditor' }] } : { rows: [] }
    );
    const { POST } = await import('../../app/api/integrations/route');
    const res = await POST(
      new Request('http://x/api/integrations', {
        method: 'POST',
        body: JSON.stringify({ provider: 'gmail', action: 'disconnect' }),
      })
    );
    expect(res.status).toBe(403);
    const writes = queryMock.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/i.test(String(sql)));
    expect(writes).toHaveLength(0);
    expect(releaseMock).toHaveBeenCalled();
  });
});
