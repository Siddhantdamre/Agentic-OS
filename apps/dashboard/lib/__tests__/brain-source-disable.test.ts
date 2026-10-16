/**
 * @jest-environment node
 *
 * MEM-B02: a knowledge source can be disabled and enabled from the Brain API.
 * The retrieval filter that honours it is checked against Postgres separately.
 */
const query = jest.fn();
const release = jest.fn();
let role = 'admin';
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: jest.fn(() => null),
}));
jest.mock('@/lib/auth-user', () => ({ lookupUserById: jest.fn(async () => ({ role })) }));
jest.mock('@/lib/embed-enqueue', () => ({ enqueueEmbedJob: jest.fn() }));
jest.mock('@/lib/brain-reindex', () => ({ enqueueReindexEmbed: jest.fn(), loadKnowledgeSourceForReindex: jest.fn() }));
const publish = jest.fn();
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: (...a: unknown[]) => publish(...a) } }));

import { PATCH } from '@/app/api/brain/[id]/route';

const ID = '11111111-1111-4111-8111-111111111111';
const call = (action: string, id = `source:${ID}`) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ action }) }), {
    params: Promise.resolve({ id: encodeURIComponent(id) }),
  });

beforeEach(() => {
  role = 'admin';
  publish.mockReset();
  query.mockReset().mockImplementation(async (_sql: string, params: unknown[]) => ({
    rows: [{ id: ID, status: params[2] ? 'disabled' : 'ready' }],
  }));
});

describe('PATCH /api/brain/source:<id> disable/enable', () => {
  it('disables the source, scoped to the org', async () => {
    const res = await call('disable');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'disabled' });
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('UPDATE knowledge_sources');
    expect(params).toEqual([ID, 'org-1', true]);
    expect(publish).toHaveBeenCalledWith('org-1', { type: 'memory.updated', message: `source:${ID}` });
  });

  it('enables it again', async () => {
    const res = await call('enable');
    expect(await res.json()).toMatchObject({ status: 'ready' });
    expect(query.mock.calls[0][1]).toEqual([ID, 'org-1', false]);
  });

  it('refuses memory rows and roles that cannot edit the Brain', async () => {
    expect((await call('disable', `org:${ID}`)).status).toBe(400);
    role = 'auditor';
    expect((await call('disable')).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('404s an id from another org', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect((await call('disable')).status).toBe(404);
  });
});
