/**
 * @jest-environment node
 *
 * Tests for Ask AI thread hydration & message persistence (ASK-B03).
 * Verifies that hydration queries the 200 newest messages in subquery (DESC)
 * and returns them in ascending chronological order (ASC), ensuring that
 * conversations with > 200 messages never drop the newest user messages.
 */

import { GET } from '@/app/api/ask-ai/route';
import type { PoolClient } from 'pg';

const mockOrgId = '00000000-0000-4000-8000-000000000001';
const mockUserId = 'user-test-persist-123';
const mockConvId = '11111111-1111-4000-8000-111111111111';

// In-memory mock database of messages for testing hydration
interface DbMessageRow {
  id: string;
  role: string;
  content: string;
  tool_calls: any;
  created_at: string;
  org_id: string;
  conversation_id: string;
}

let mockMessagesStore: DbMessageRow[] = [];
let lastExecutedSql = '';
let lastExecutedParams: any[] = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => {
    const mockClient = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        lastExecutedSql = sql;
        lastExecutedParams = params;

        // orgs lookup
        if (sql.includes('SELECT name FROM orgs')) {
          return { rows: [{ name: 'Acme Test Corp' }] };
        }
        // channels lookup
        if (sql.includes('SELECT channel_type FROM channels')) {
          return { rows: [{ channel_type: 'email' }, { channel_type: 'whatsapp' }] };
        }
        // conversation lookup
        if (sql.includes('SELECT id, summary FROM conversations')) {
          return { rows: [{ id: mockConvId, summary: 'Test Chat' }] };
        }
        // loadConversationAskMode lookup
        if (sql.includes('metadata->>\'askMode\'') || sql.includes('conversations WHERE id = $1')) {
          return { rows: [{ metadata: { askMode: 'auto', askEmployeeIds: [] } }] };
        }
        // messages hydration query (ASK-B03)
        if (sql.includes('FROM messages')) {
          // Verify the query contract: must order by DESC inside subquery with LIMIT 200, then ASC outside
          const matchesContract =
            sql.includes('ORDER BY created_at DESC') &&
            sql.includes('LIMIT 200') &&
            sql.includes('ORDER BY created_at ASC');

          if (!matchesContract) {
            throw new Error(`Hydration query does not match DESC subquery + ASC outer sort contract:\n${sql}`);
          }

          // Simulate SQL query:
          // 1. Filter by org_id and conversation_id
          const filtered = mockMessagesStore.filter(
            (m) => m.org_id === params[0] && m.conversation_id === params[1]
          );
          // 2. Subquery: ORDER BY created_at DESC LIMIT 200
          const subquery = [...filtered]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .slice(0, 200);
          // 3. Outer query: ORDER BY created_at ASC
          const outer = [...subquery].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );

          return { rows: outer };
        }
        // agent_plans lookup
        if (sql.includes('FROM agent_plans')) {
          return { rows: [] };
        }

        return { rows: [] };
      }),
      release: jest.fn(),
    };

    return {
      client: mockClient as unknown as PoolClient,
      orgId: mockOrgId,
      userId: mockUserId,
    };
  }),
  scopedAuthErrorResponse: jest.fn(() => null),
  releaseScopedClient: jest.fn(async () => {}),
  getOrgScopedClient: jest.fn(),
}));

jest.mock('@/lib/rate-limit', () => ({
  denyAskAiIfLimitedAsync: jest.fn(() => null),
  denyAskAiBusy: jest.fn(() => null),
  tryAcquireConcurrency: jest.fn(() => ({ allowed: true, release: jest.fn() })),
  isRateLimitError: jest.fn(() => false),
  responseFromRateLimit: jest.fn(),
}));

describe('Ask AI Thread Hydration (ASK-B03)', () => {
  beforeEach(() => {
    mockMessagesStore = [];
    lastExecutedSql = '';
    lastExecutedParams = [];
  });

  it('hydrates all messages when conversation has <= 200 messages', async () => {
    // Populate 50 messages
    for (let i = 1; i <= 50; i++) {
      mockMessagesStore.push({
        id: `msg-${String(i).padStart(3, '0')}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Message content ${i}`,
        tool_calls: null,
        created_at: new Date(Date.UTC(2026, 8, 20, 10, 0, i)).toISOString(),
        org_id: mockOrgId,
        conversation_id: mockConvId,
      });
    }

    const req = new Request(`https://app.darex.test/api/ask-ai?conversationId=${mockConvId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.conversationId).toBe(mockConvId);
    expect(body.messages).toHaveLength(50);
    expect(body.messages[0].id).toBe('msg-001');
    expect(body.messages[49].id).toBe('msg-050');
  });

  it('hydrates the 200 newest messages when conversation has > 200 messages (e.g. 205 messages)', async () => {
    // Populate 205 messages in chronological order (msg-001 to msg-205)
    for (let i = 1; i <= 205; i++) {
      mockMessagesStore.push({
        id: `msg-${String(i).padStart(3, '0')}`,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Message ${i}: ${i === 205 ? 'Latest user question' : 'Historical message'}`,
        tool_calls: i === 10 ? [{ name: 'web_search', args: { query: 'test' } }] : null,
        created_at: new Date(Date.UTC(2026, 8, 20, 10, 0, i)).toISOString(),
        org_id: mockOrgId,
        conversation_id: mockConvId,
      });
    }

    const req = new Request(`https://app.darex.test/api/ask-ai?conversationId=${mockConvId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    // Must return exactly 200 messages (capped by LIMIT 200)
    expect(body.messages).toHaveLength(200);

    // Oldest messages (msg-001 to msg-005) must be truncated/dropped from the recent history window
    const messageIds = body.messages.map((m: any) => m.id);
    expect(messageIds).not.toContain('msg-001');
    expect(messageIds).not.toContain('msg-002');
    expect(messageIds).not.toContain('msg-003');
    expect(messageIds).not.toContain('msg-004');
    expect(messageIds).not.toContain('msg-005');

    // First returned message must be msg-006
    expect(body.messages[0].id).toBe('msg-006');

    // Most recent messages (msg-200 through msg-205) MUST be present in ascending order!
    expect(messageIds).toContain('msg-200');
    expect(messageIds).toContain('msg-204');
    expect(messageIds).toContain('msg-205');

    // The very last message in the returned array MUST be the newest message msg-205
    const lastMessage = body.messages[body.messages.length - 1];
    expect(lastMessage.id).toBe('msg-205');
    expect(lastMessage.content).toBe('Message 205: Latest user question');

    // tool_calls must be mapped to toolCalls in the response
    const msg10 = body.messages.find((m: any) => m.id === 'msg-010');
    expect(msg10?.toolCalls).toEqual([{ name: 'web_search', args: { query: 'test' } }]);
  });
});
