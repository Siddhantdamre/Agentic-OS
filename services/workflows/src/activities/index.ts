import { Pool } from 'pg';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { runAgentTurn } from '../atomic-agent-client.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD, // Must be set via env — no insecure fallback
  database: process.env.DB_NAME || 'darex',
});

export async function runAgentTurnActivity(input: AgentTaskInput): Promise<AgentTaskResult> {
  const steps: AgentTaskResult['executedSteps'] = [];
  const usedTools: string[] = [];
  try {
    const turn = await runAgentTurn(input);
    turn.tools.forEach((t, i) => {
      usedTools.push(t.tool);
      steps.push({
        step: i + 1,
        action: `Execute Tool: ${t.tool}`,
        toolUsed: t.tool,
        result: t.argsLabel ? `args: ${t.argsLabel}` : 'tool executed',
      });
    });
    steps.push({
      step: steps.length + 1,
      action: 'Final Response Synthesis',
      result: `Generated reply: "${turn.reply.slice(0, 60)}..."`,
    });
    return { success: true, replyMessage: turn.reply, executedSteps: steps, usedTools };
  } catch (err: any) {
    console.error('[Temporal Activity] runAgentTurn failed:', err.message);
    steps.push({
      step: 1,
      action: 'Agent Turn',
      result: `Failed: ${err.message}`,
    });
    return {
      success: false,
      replyMessage: `I encountered an issue processing your request. Please try again.`,
      executedSteps: steps,
      usedTools,
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
      `INSERT INTO channel_logs (org_id, channel_id, log_type, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [params.orgId, params.channelId || null, params.logType, JSON.stringify(params.payload)]
    );
    return { logId: res.rows[0].id };
  } catch (err) {
    console.error('logChannelActivity error:', err);
    return { logId: `fallback_log_${Date.now()}` };
  } finally {
    client.release();
  }
}
