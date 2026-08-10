import { Pool } from 'pg';
import { executeAutonomousToolAction } from '../tool-executor.js';
import { HermesAgentAdapter } from '../hermes-agent.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD, // Must be set via env — no insecure fallback
  database: process.env.DB_NAME || 'darex',
});

export async function executeToolActivity(
  tool: string,
  action: string,
  payload: any,
  orgId?: string
): Promise<{ status: string; data: any }> {
  if (!orgId) {
    console.warn(`[Temporal Activity] executeToolActivity called without orgId for tool: ${tool}`);
  }
  console.log(`[Temporal Activity] Executing tool: ${tool}, action: ${action}, org: ${orgId || 'unknown'}`);

  // Special virtual tools for Hermes planning and reply synthesis
  if (tool === 'hermes_plan') {
    try {
      const adapter = new HermesAgentAdapter(orgId || '', orgId || '');
      const planningPrompt = `You are the decision-making brain of AI employee ${payload.employeeName} (${payload.employeeRole}).
Available Tools in Allowlist: ${JSON.stringify(payload.toolAllowlist)}

Analyze the user's message and decide if any tool from the allowlist should be called.
Respond ONLY with a JSON object:
{
  "targetTool": "<tool_name_from_allowlist or null>",
  "actionRequired": "<action_name or 'reply'>",
  "toolParams": { ...extracted_parameters... }
}`;
      const hermesRes = await adapter.executeTask({
        prompt: `SYSTEM:\n${planningPrompt}\n\nUSER MESSAGE:\n${payload.userMessage}`,
        provider: 'openrouter',
        mode: 'reason',
        employeeName: payload.employeeName,
        employeeRole: payload.employeeRole,
        employeePersona: payload.employeePersona,
        toolAllowlist: payload.toolAllowlist,
      });
      try {
        const parsed = JSON.parse(hermesRes.finalResponse.replace(/```json|```/g, '').trim());
        return { status: 'success', data: parsed };
      } catch {
        return { status: 'success', data: { targetTool: null, actionRequired: 'reply', toolParams: {} } };
      }
    } catch (err: any) {
      console.warn('[Temporal] hermes_plan failed:', err.message);
      return { status: 'success', data: { targetTool: null, actionRequired: 'reply', toolParams: {} } };
    }
  }

  if (tool === 'hermes_reply') {
    try {
      const adapter = new HermesAgentAdapter(orgId || '', orgId || '');
      const replyPrompt = `You are AI employee ${payload.employeeName} (${payload.employeeRole}).
Persona: ${payload.employeePersona}

Tool execution history:
${JSON.stringify(payload.executedSteps, null, 2)}

Generate a professional, helpful response to the user message: "${payload.userMessage}"`;
      const hermesRes = await adapter.executeTask({
        prompt: replyPrompt,
        provider: 'gemini',
        mode: 'reason',
        employeeName: payload.employeeName,
        employeeRole: payload.employeeRole,
        employeePersona: payload.employeePersona,
      });
      return { status: 'success', data: { reply: hermesRes.finalResponse } };
    } catch (err: any) {
      console.warn('[Temporal] hermes_reply failed:', err.message);
      return { status: 'success', data: { reply: `Hello! I am ${payload.employeeName}. I have processed your request.` } };
    }
  }

  // Standard tool execution
  try {
    const result = await executeAutonomousToolAction({
      tool,
      action,
      payload: payload || {},
      orgId: orgId || '',
    });
    return { status: result.status, data: result.data };
  } catch (err: any) {
    console.error(`[Temporal Activity Error] Tool ${tool} failed:`, err.message);
    return { status: 'error', data: { message: err.message } };
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
