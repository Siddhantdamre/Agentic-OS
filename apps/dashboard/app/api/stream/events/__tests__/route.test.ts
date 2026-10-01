/**
 * @jest-environment node
 */
const query = jest.fn();
const release = jest.fn();

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));

jest.mock('@/lib/realtime-hub', () => ({
  realtimeHub: {
    ensureReady: jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }),
    subscribe: jest.fn(),
    replayEvents: jest.fn(async () => []),
  },
  acquireStreamSlot: () => () => undefined,
  sseEventName: (t: string) => t,
}));

// eslint-disable-next-line import/first
import { GET } from '../route';

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(needle)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('GET /api/stream/events with Redis down', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    query.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stays a 200 event stream in polling mode and emits DB changes', async () => {
    query.mockImplementation(async (sql: string) => {
      const row = { id: 'id-1', status: 'open', updated_at: new Date().toISOString() };
      if (sql.includes('FROM work_items')) return { rows: [row] };
      return { rows: [] };
    });
    const abort = new AbortController();
    const res = await GET(new Request('http://x/api/stream/events', { signal: abort.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const first = await readUntil(reader, 'polling');
    expect(first).toContain('event: connected');
    expect(first).toContain('"mode":"polling"');

    await jest.advanceTimersByTimeAsync(10_000);
    const next = await readUntil(reader, 'work_item_updated');
    expect(next).toContain('event: work_item_updated');
    expect(next).toContain('"message":"id-1"');
    abort.abort();
  });
});
