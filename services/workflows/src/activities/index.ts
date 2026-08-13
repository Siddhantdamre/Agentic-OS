import { Context } from '@temporalio/activity';
import { Pool, PoolClient } from 'pg';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { runAutonomousAgentDirect } from '../atomic-agent-client.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
});

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    return await fn(client);
  } finally {
    client.release();
  }
}

async function readIdempotent<T>(orgId: string, key: string | undefined): Promise<T | null> {
  if (!key) return null;
  return withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND org_id = $2 AND expires_at > NOW()`,
      [key, orgId]
    );
    if (res.rows.length === 0) return null;
    return (res.rows[0].result as T) ?? null;
  });
}

async function writeIdempotent(orgId: string, key: string | undefined, result: unknown): Promise<void> {
  if (!key) return;
  await withOrgClient(orgId, async (client) => {
    await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`,
      [key, orgId, JSON.stringify(result)]
    );
  });
}

function workflowIdempotencyKey(suffix: string): string | undefined {
  try {
    const info = Context.current().info;
    const wfId = info.workflowExecution.workflowId;
    if (!wfId) return undefined;
    return `wf:${wfId}:${suffix}`;
  } catch {
    return undefined;
  }
}

export async function runAgentTurnActivity(input: AgentTaskInput): Promise<AgentTaskResult> {
  try {
    let priorMessages: { role: string; content: string }[] = [];
    if (input.conversationId) {
      try {
        priorMessages = await withOrgClient(input.orgId, async (client) => {
          const res = await client.query(
            `SELECT role, content FROM (
               SELECT role, content, created_at
               FROM messages
               WHERE org_id = $1 AND conversation_id = $2
               ORDER BY created_at DESC
               LIMIT 10
             ) sub ORDER BY created_at ASC`,
            [input.orgId, input.conversationId]
          );
          return res.rows.map((r) => ({ role: r.role, content: r.content }));
        });
      } catch (e) {
        console.error('Failed to load prior messages', e);
      }
    }
    return await runAutonomousAgentDirect(input, { priorMessages });
  } catch (err: any) {
    console.error('[Temporal Activity] runAgentTurn failed:', err.message);
    return {
      success: false,
      replyMessage: 'I encountered an issue processing your request. Please try again.',
      executedSteps: [
        { step: 1, action: 'Agent Turn', result: `Failed: ${err.message}` },
      ],
      usedTools: [],
      error: err.message,
      retryable: /timeout|timed out|abort/i.test(String(err.message || '')),
      isDone: true,
    };
  }
}

export async function saveMessageActivity(params: {
  orgId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: any;
  idempotencyKey?: string;
}): Promise<{ messageId: string }> {
  const key = params.idempotencyKey || workflowIdempotencyKey(`save:${params.role}:${params.conversationId}`);
  const cached = await readIdempotent<{ messageId: string }>(params.orgId, key);
  if (cached?.messageId) return cached;

  const saved = await withOrgClient(params.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [params.orgId, params.conversationId, params.role, params.content, JSON.stringify(params.toolCalls || [])]
    );
    return { messageId: res.rows[0].id as string };
  });

  await writeIdempotent(params.orgId, key, saved);
  return saved;
}

export async function logChannelActivity(params: {
  orgId: string;
  channelId?: string;
  logType: string;
  payload: any;
  idempotencyKey?: string;
}): Promise<{ logId: string }> {
  const key = params.idempotencyKey || workflowIdempotencyKey(`log:${params.logType}`);
  const cached = await readIdempotent<{ logId: string }>(params.orgId, key);
  if (cached?.logId) return cached;

  const saved = await withOrgClient(params.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, $3, 'success', 200, $4, $5)
       RETURNING id`,
      [params.orgId, params.channelId || 'agent', params.logType, params.logType, JSON.stringify(params.payload)]
    );
    return { logId: res.rows[0].id as string };
  });

  await writeIdempotent(params.orgId, key, saved);
  return saved;
}
