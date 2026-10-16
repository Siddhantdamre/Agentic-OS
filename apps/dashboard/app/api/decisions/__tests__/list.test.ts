/**
 * @jest-environment node
 *
 * The approvals page and the sidebar badge read this list. It must say which employee is asking (a person approves
 * "Emma wants to send this", not "customer_support wants..."), and the badge must be able to ask for the count alone.
 */
const queries: Array<{ sql: string; params: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    client: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (/count\(\*\)/i.test(sql)) return { rows: [{ n: '3' }] };
        return { rows };
      }),
      release: jest.fn(),
    },
    orgId: 'org-1',
    userId: 'u-1',
  })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));
jest.mock('@/lib/decide-approval', () => ({ decideApproval: jest.fn() }));

import { NextRequest } from 'next/server';
import { GET } from '../route';

const req = (qs = '') => new NextRequest(`http://localhost/api/decisions${qs}`);

beforeEach(() => { queries.length = 0; rows = []; });

describe('GET /api/decisions', () => {
  it('names the employee that is asking, looked up inside this workspace', async () => {
    rows = [{ id: 'a1', action_type: 'external_send', employee_role: 'Customer Support', employee_name: 'Emma', payload: { summary: 's' }, status: 'pending', created_at: '2026-10-07T11:55:00Z' }];
    const res = await GET(req());
    const body = await res.json();
    expect(body.decisions[0]).toMatchObject({ id: 'a1', employeeName: 'Emma', employeeRole: 'Customer Support' });
    const sql = queries[0].sql;
    expect(sql).toMatch(/ai_employees/);
    expect(sql).toMatch(/e\.org_id\s*=\s*p\.org_id/); // the join is scoped to the same workspace
    expect(queries[0].params).toEqual(['org-1']);
  });

  it('does not list a request that has already expired as something to approve', async () => {
    await GET(req());
    expect(queries[0].sql).toMatch(/expires_at IS NULL OR p\.expires_at > NOW\(\)|expires_at IS NULL OR expires_at > NOW\(\)/);
  });

  it('can answer with the count alone, for the sidebar badge', async () => {
    const res = await GET(req('?count=1'));
    expect(await res.json()).toEqual({ pending: 3 });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/status\s*=\s*'pending'/);
    expect(queries[0].sql).not.toMatch(/payload/); // no row data is read just to draw a number
  });

  it('does not count what has already expired', async () => {
    await GET(req('?count=1'));
    expect(queries[0].sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
  });

  it('lists the history with who decided and what came of it', async () => {
    rows = [{ id: 'h1', action_type: 'external_send', employee_role: 'Support', employee_name: null, payload: {}, status: 'executed', executed_at: '2026-10-07T11:56:00Z', decided_at: '2026-10-07T11:55:30Z', created_at: '2026-10-07T11:50:00Z' }];
    const body = await (await GET(req('?history=1'))).json();
    expect(body.decisions[0]).toMatchObject({ id: 'h1', status: 'executed', employeeName: null });
  });
});
