import type { AgentTaskInput } from './agent-engine.js';

export interface AgentToolStep {
  tool: string;
  argsLabel: string;
}

export interface AgentTurnResult {
  reply: string;
  sessionId: string;
  model: string;
  tools: AgentToolStep[];
}

const ATOMIC_AGENT_URL = process.env.ATOMIC_AGENT_URL || 'http://localhost:8787';
const ATOMIC_AGENT_API_KEY = process.env.ATOMIC_AGENT_API_KEY || 'darex-atomic-agent-dev-key';
const ATOMIC_AGENT_MODEL = process.env.ATOMIC_AGENT_MODEL || 'atomic-agent';
const AGENT_TURN_TIMEOUT_MS = parseInt(process.env.ATOMIC_AGENT_TIMEOUT_MS || '180000', 10);

function buildSystemPrompt(input: AgentTaskInput): string {
  const lines = [
    `You are ${input.employeeName}, an AI employee of the DarEX organisation ${input.orgId}.`,
    `Your role: ${input.employeeRole}`,
    `Your persona: ${input.employeePersona}`,
    `Your org_id is ${input.orgId}. When calling mcp.darex.database_query or mcp.darex.database_execute, always pass org_id = "${input.orgId}" unless the user explicitly gives a different one, and never ask for it.`,
    `Use the available mcp.darex tools when they help accomplish the user's request. Keep replies professional, warm and natural, and integrate any tool results smoothly.`,
  ];
  return lines.join('\n');
}

function buildSessionId(input: AgentTaskInput): string {
  if (input.conversationId) return `darex:${input.orgId}:${input.conversationId}`;
  return `darex:${input.orgId}:${input.employeeId || 'chat'}`;
}

interface SseState {
  reply: string;
  sessionId: string;
  model: string;
  tools: AgentToolStep[];
  errorText: string;
}

function handleSseData(payload: string, eventType: string | null, state: SseState): boolean {
  if (payload === '[DONE]') return true;
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return false;
  }
  if (eventType === 'tool_progress') {
    state.tools.push({
      tool: typeof json.tool === 'string' ? json.tool : 'unknown',
      argsLabel: typeof json.label === 'string' ? json.label : '',
    });
  } else if (eventType === 'session_id') {
    const sid = json.session_id ?? json.sessionId;
    if (typeof sid === 'string' && sid.length > 0) state.sessionId = sid;
  } else if (eventType === 'error') {
    state.errorText = typeof json.error === 'string' ? json.error : JSON.stringify(json);
  } else {
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) state.reply += delta;
    if (typeof json.model === 'string') state.model = json.model;
  }
  return false;
}

async function readSseStream(body: ReadableStream<Uint8Array>, sessionId: string): Promise<AgentTurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType: string | null = null;
  const state: SseState = {
    reply: '',
    sessionId,
    model: '',
    tools: [],
    errorText: '',
  };
  let done = false;
  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length === 0) {
          eventType = null;
        } else if (line.startsWith('event:')) {
          eventType = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          const payload = line.slice('data:'.length).trim();
          if (handleSseData(payload, eventType, state)) {
            done = true;
            break;
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (state.errorText) {
    throw new Error(`atomic-agent stream error: ${state.errorText}`);
  }
  return {
    reply: state.reply,
    sessionId: state.sessionId || sessionId,
    model: state.model || ATOMIC_AGENT_MODEL,
    tools: state.tools,
  };
}

export async function runAgentTurn(input: AgentTaskInput): Promise<AgentTurnResult> {
  const sessionId = buildSessionId(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TURN_TIMEOUT_MS);
  try {
    const res = await fetch(`${ATOMIC_AGENT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATOMIC_AGENT_API_KEY}`,
        'X-Atomic-Extensions': 'on',
      },
      body: JSON.stringify({
        model: ATOMIC_AGENT_MODEL,
        stream: true,
        session_id: sessionId,
        messages: [
          { role: 'system', content: buildSystemPrompt(input) },
          { role: 'user', content: input.userMessage },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`atomic-agent HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('atomic-agent returned no response body');

    return await readSseStream(res.body, sessionId);
  } finally {
    clearTimeout(timeout);
  }
}