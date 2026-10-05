/**
 * @jest-environment node
 *
 * Next 15 passes dynamic route params as a Promise. A handler that reads
 * `params.id` without awaiting sees `undefined`, so a valid id is rejected as
 * invalid before auth is ever checked. Each case sends a valid id and expects
 * the handler to reach getScopedClient, plus an invalid id that must 400 first.
 */
const getScopedClient = jest.fn(async () => {
  throw new Error('Unauthorized');
});
jest.mock('@/lib/db', () => ({
  getScopedClient: () => getScopedClient(),
  scopedAuthErrorResponse: jest.fn(() => new Response(null, { status: 401 })),
}));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));
jest.mock('@darex/workflows/dist/dsr/run-export', () => ({ dsrArtifactRoot: () => '/tmp' }));
jest.mock('@darex/connectors', () => ({}));
jest.mock('@darex/whatsapp-gateway', () => ({}));

import * as listing from '@/app/api/listings/[id]/route';
import * as showing from '@/app/api/showings/[id]/route';
import * as employee from '@/app/api/employees/[id]/route';
import * as metrics from '@/app/api/employees/[id]/metrics/route';
import * as activity from '@/app/api/employees/[id]/activity/route';
import * as dsrDownload from '@/app/api/dsr/[id]/download/route';
import * as ping from '@/app/api/integrations/[provider]/ping/route';

const ID = '11111111-1111-4111-8111-111111111111';
const req = (method: string) =>
  new Request('http://x', { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
// One params shape every handler accepts, so the table can mix [id] and [provider] routes.
type Params = { id: string; provider: string };
type Handler = (r: Request, ctx: { params: Promise<Params> }) => Promise<Response>;

const cases: Array<[string, Handler, string, Record<string, string>]> = [
  ['GET /api/listings/:id', listing.GET, 'GET', { id: ID }],
  ['PATCH /api/listings/:id', listing.PATCH, 'PATCH', { id: ID }],
  ['DELETE /api/listings/:id', listing.DELETE, 'DELETE', { id: ID }],
  ['PATCH /api/showings/:id', showing.PATCH, 'PATCH', { id: ID }],
  ['DELETE /api/showings/:id', showing.DELETE, 'DELETE', { id: ID }],
  ['GET /api/employees/:id', employee.GET, 'GET', { id: ID }],
  ['DELETE /api/employees/:id', employee.DELETE, 'DELETE', { id: ID }],
  ['GET /api/employees/:id/metrics', metrics.GET, 'GET', { id: ID }],
  ['GET /api/employees/:id/activity', activity.GET, 'GET', { id: ID }],
  ['GET /api/dsr/:id/download', dsrDownload.GET, 'GET', { id: ID }],
  ['POST /api/integrations/:provider/ping', ping.POST, 'POST', { provider: 'gmail' }],
];

beforeEach(() => getScopedClient.mockClear());

describe('dynamic route handlers await their params', () => {
  it.each(cases)('%s reads a valid param and reaches auth', async (_name, handler, method, params) => {
    const res = await handler(req(method), { params: Promise.resolve(params as Params) });
    expect(getScopedClient).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(400);
  });

  it.each(cases)('%s rejects an invalid param before auth', async (_name, handler, method, params) => {
    const bad = Object.fromEntries(Object.keys(params).map((k) => [k, 'not-valid!']));
    const res = await handler(req(method), { params: Promise.resolve(bad as Params) });
    expect(res.status).toBe(400);
    expect(getScopedClient).not.toHaveBeenCalled();
  });
});
