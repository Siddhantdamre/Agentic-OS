/**
 * @jest-environment node
 */
import type { PoolClient } from 'pg';
import { upsertOrgConnector } from '../connector-registry';

describe('upsertOrgConnector', () => {
  it('conflicts on the full org_connectors unique key including account_id', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const client = { query } as unknown as PoolClient;

    await upsertOrgConnector(client, 'org-1', 'gmail', { status: 'connected' });

    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('ON CONFLICT (org_id, connector_key, account_id)');
  });
});
