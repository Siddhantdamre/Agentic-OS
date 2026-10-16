/**
 * @jest-environment node
 */
import { decideOne, outcomeFor, APPROVALS_CHANGED_EVENT, type Outcome } from '../approvals-client';

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('outcomeFor', () => {
  it('says plainly what became of an approval', () => {
    expect(outcomeFor('approved', { status: 'executed' }, 'email')).toEqual({ tone: 'done', text: 'Approved and sent.' });
    expect(outcomeFor('approved', { status: 'executed' }, 'refund')).toEqual({ tone: 'done', text: 'Approved and done.' });
    expect(outcomeFor('rejected', { status: 'rejected' }, 'email')).toEqual({ tone: 'done', text: 'Rejected. Nothing was sent.' });
    expect(outcomeFor('approved', { status: 'pending', awaitingApprovals: 1 }, 'refund')).toEqual({ tone: 'waiting', text: 'Your approval is recorded. It needs 1 more person before it runs.' });
    expect(outcomeFor('approved', { status: 'pending', awaitingApprovals: 2 }, 'refund').text).toMatch(/2 more people/);
  });
  it('says it did not run when the action failed, never that it was sent', () => {
    const o = outcomeFor('approved', { status: 'execution_failed', error: 'The connection was refused. It did not run.' }, 'email');
    expect(o.tone).toBe('failed');
    expect(o.text).toBe('Approved, but it did not run: The connection was refused. It did not run.');
  });
});

describe('decideOne', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends the decision for that one request and reports the outcome', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init: init as RequestInit }); return json(200, { success: true, status: 'executed' }); }) as unknown as typeof fetch;
    const o = await decideOne({ id: 'a1', decision: 'approved', kind: 'email' });
    expect(calls[0].url).toBe('/api/decisions');
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: 'a1', status: 'approved' });
    expect(o).toEqual<Outcome>({ tone: 'done', text: 'Approved and sent.' });
  });

  it('sends an edited message as the replacement for what the employee wrote', async () => {
    let body: unknown;
    global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json(200, { success: true, status: 'executed' }); }) as unknown as typeof fetch;
    await decideOne({ id: 'a1', decision: 'approved', kind: 'email', modifiedPayload: { to: 'a@b.co', subject: 'Hi', body: 'Edited' } });
    expect(body).toEqual({ id: 'a1', status: 'approved', modifiedPayload: { to: 'a@b.co', subject: 'Hi', body: 'Edited' } });
  });

  it('reads a failed run from the error body, which the server sends with a 500', async () => {
    global.fetch = jest.fn(async () => json(500, { success: false, status: 'execution_failed', error: 'The action did not run.' })) as unknown as typeof fetch;
    const o = await decideOne({ id: 'a1', decision: 'approved', kind: 'email' });
    expect(o.tone).toBe('failed');
    expect(o.text).toContain('The action did not run.');
  });

  it('turns a refusal into a sentence a person can act on', async () => {
    global.fetch = jest.fn(async () => json(403, { error: 'Only workspace owners and admins can approve refunds.' })) as unknown as typeof fetch;
    const o = await decideOne({ id: 'r1', decision: 'approved', kind: 'refund' });
    expect(o).toEqual({ tone: 'failed', text: 'Only workspace owners and admins can approve refunds.' });
  });

  it('never shows a bare "Forbidden" or a raw server error', async () => {
    global.fetch = jest.fn(async () => json(403, { error: 'Forbidden' })) as unknown as typeof fetch;
    expect((await decideOne({ id: 'a1', decision: 'approved', kind: 'email' })).text).toBe('Your role is not allowed to approve this.');
    global.fetch = jest.fn(async () => json(500, { error: 'connect ECONNREFUSED 10.0.0.5:5432' })) as unknown as typeof fetch;
    const o = await decideOne({ id: 'a1', decision: 'approved', kind: 'email' });
    expect(o.text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    global.fetch = jest.fn(async () => json(409, { error: 'Decision already executed' })) as unknown as typeof fetch;
    expect((await decideOne({ id: 'a1', decision: 'approved', kind: 'email' })).text).toBe('Decision already executed');
  });

  it('says so, plainly, when the connection drops, and never throws', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const o = await decideOne({ id: 'a1', decision: 'approved', kind: 'email' });
    expect(o.tone).toBe('failed');
    expect(o.text).toMatch(/connection|reach/i);
    expect(o.text).not.toMatch(/Failed to fetch|TypeError/);
  });

  it('announces a change so the sidebar count updates at once', () => {
    expect(APPROVALS_CHANGED_EVENT).toBe('darex:approvals-changed');
  });
});
