/**
 * @jest-environment node
 *
 * When the AI holds its answer for the owner, an opted-in customer gets a short
 * "a teammate will follow up" note instead of silence.
 */
const query = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release: jest.fn() }, orgId: 'org-1' })),
}));
const deliver = jest.fn();
jest.mock('@/lib/inbound-agent', () => ({ deliverInboundReply: (...a: unknown[]) => deliver(...a) }));

import { watchForHoldingReply } from '@/lib/whatsapp-holding-reply';

const job = (enabled: boolean) =>
  ({
    orgId: 'org-1',
    conversationId: 'conv-1',
    inboundEventId: 'MSG1',
    autoReply: { holdingReply: { enabled, message: 'One moment please.' } },
  }) as never;

beforeEach(() => {
  query.mockReset();
  deliver.mockReset().mockResolvedValue(undefined);
});

describe('watchForHoldingReply', () => {
  it('does nothing when the owner did not opt in', async () => {
    expect(await watchForHoldingReply(job(false), { intervalMs: 1, maxMs: 20 })).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('sends the note once the confidence gate opens', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    expect(await watchForHoldingReply(job(true), { intervalMs: 1, maxMs: 500 })).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toBe('One moment please.');
    expect(deliver.mock.calls[0][2]).toMatchObject({ savedByWorkflow: false, sendKey: 'holding:MSG1' });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("confidence_below_threshold");
    expect(query.mock.calls[0][1].slice(0, 2)).toEqual(['org-1', 'conv-1']);
  });

  it('says nothing if the AI answers on its own (gate never opens)', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await watchForHoldingReply(job(true), { intervalMs: 1, maxMs: 30 })).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a database error stops the watch without sending', async () => {
    query.mockRejectedValue(new Error('db down'));
    expect(await watchForHoldingReply(job(true), { intervalMs: 1, maxMs: 200 })).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });
});
