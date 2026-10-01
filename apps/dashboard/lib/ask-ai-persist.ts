import { PoolClient } from 'pg';
import crypto from 'crypto';
import { pool } from '@/lib/db';

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pc = await pool.connect();
  try {
    await pc.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(pc);
  } finally {
    try {
      await pc.query('RESET app.current_org_id');
    } catch {
      // ignore
    }
    pc.release();
  }
}

export async function insertAskAiMessage(
  client: PoolClient,
  orgId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO messages (id, org_id, conversation_id, role, content, tool_calls, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
    [crypto.randomUUID(), orgId, conversationId, role, content, JSON.stringify(toolCalls || null)]
  );
  if (role === 'user') {
    await client.query(
      `UPDATE conversations
       SET summary = CASE
         WHEN summary IS NULL OR summary = 'Ask AI' OR summary = 'New Chat' OR summary = ''
         THEN $3
         ELSE summary
       END,
       updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [conversationId, orgId, content.slice(0, 100).trim()]
    );
  } else {
    await client.query(
      `UPDATE conversations SET updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [conversationId, orgId]
    );
  }
}

export async function persistAskAiMessage(
  orgId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: unknown
): Promise<void> {
  await withOrgClient(orgId, (c) => insertAskAiMessage(c, orgId, conversationId, role, content, toolCalls));
}
