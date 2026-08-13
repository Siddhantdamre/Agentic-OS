import { Pool } from 'pg';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { runAgentTurn, mapTurnToResult } from '../atomic-agent-client.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD, // Must be set via env — no insecure fallback
  database: process.env.DB_NAME || 'darex',
});

export async function runAgentTurnActivity(input: AgentTaskInput): Promise<AgentTaskResult> {
  try {
    let priorMessages: { role: string; content: string }[] = [];
    if (input.conversationId) {
      const client = await pool.connect();
      try {
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [input.orgId]);
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
        priorMessages = res.rows.map(r => ({ role: r.role, content: r.content }));
      } catch (e) {
        console.error('Failed to load prior messages', e);
      } finally {
        client.release();
      }
    }
    const turn = await runAgentTurn(input, { priorMessages });
    return mapTurnToResult(turn);
  } catch (err: any) {
    console.error('[Temporal Activity] runAgentTurn failed:', err.message);
    return {
      success: false,
      replyMessage: `I encountered an issue processing your request. Please try again.`,
      executedSteps: [
        { step: 1, action: 'Agent Turn', result: `Failed: ${err.message}` },
      ],
      usedTools: [],
    };
  }
}

export async function saveMessageActivity(params: {
  orgId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: any;
}): Promise<{ messageId: string }> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [params.orgId]);
    const res = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [params.orgId, params.conversationId, params.role, params.content, JSON.stringify(params.toolCalls || [])]
    );
    return { messageId: res.rows[0].id };
  } catch (err) {
    console.error('saveMessageActivity error:', err);
    return { messageId: `fallback_${Date.now()}` };
  } finally {
    client.release();
  }
}

export async function logChannelActivity(params: {
  orgId: string;
  channelId?: string;
  logType: string;
  payload: any;
}): Promise<{ logId: string }> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [params.orgId]);
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, $3, 'success', 200, $4, $5)
       RETURNING id`,
      [params.orgId, params.channelId || 'agent', params.logType, params.logType, JSON.stringify(params.payload)]
    );
    return { logId: res.rows[0].id };
  } catch (err) {
    console.error('logChannelActivity error:', err);
    return { logId: `fallback_log_${Date.now()}` };
  } finally {
    client.release();
  }
}
