import type { AgentTaskInput, AgentTaskResult } from './agent-engine.js';

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
const ATOMIC_AGENT_MODEL = process.env.ATOMIC_AGENT_MODEL || 'atomic-agent';

function requireAtomicAgentKey(): string {
  const key = process.env.ATOMIC_AGENT_API_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ATOMIC_AGENT_API_KEY is required in production');
  }
  return 'darex-atomic-agent-dev-key';
}
const AGENT_TURN_TIMEOUT_MS = parseInt(process.env.ATOMIC_AGENT_TIMEOUT_MS || '180000', 10);
const AGENT_MAX_RETRIES = parseInt(process.env.ATOMIC_AGENT_MAX_RETRIES || '2', 10);

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(input: AgentTaskInput): string {
  const lines = [
    `You are ${input.employeeName}, an AI employee of the DarEX organisation ${input.orgId}.`,
    `Your role: ${input.employeeRole}`,
    `Your persona: ${input.employeePersona}`,
    `FIXED LEASEHOLD FACTS — these are TRUE and KNOWN, never re-derive them:`,
    `- Your org_id is ${input.orgId}.`,
    `- The user will NOT supply org_id to you; it is already given above.`,
    `When calling any mcp.darex.* tool that needs org_id or conversation_id, you MUST pass org_id = "${input.orgId}" directly.`,
    `NEVER ask the user for an org_id. NEVER search memory, profile, notes, MCP resources or MCP prompts to find an org_id. If you are about to do that, stop, and instead call the mcp.darex tool with org_id = "${input.orgId}".`,
    `Use the available mcp.darex tools when they help accomplish the user's request. Keep replies professional, warm and natural, and integrate any tool results smoothly.`,
  ];
  return lines.join('\n');
}

/**
 * Ground the agent turn with facts atomic-agent must not forget. atomic-agent's
 * OpenAI-compatible HTTP handler drops the `system` role message entirely, so
 * org-scoped facts are embedded in the user message — the only part of the
 * request guaranteed to reach the LLM prompt.
 */
function buildGroundedUserMessage(input: AgentTaskInput): string {
  const facts = [
    `SYSTEM CONTEXT (authoritative, do not question):`,
    `- You are operating as an AI employee for organisation org_id=${input.orgId}.`,
    `- This org_id is ALREADY known to you. The user is a customer/employee of this org.`,
    `- When any mcp.darex.* tool requires org_id, pass org_id=${JSON.stringify(input.orgId)}. Never ask the user for it and never search memory/profile/notes/resources/prompts to find it.`,
    `- If a mcp.darex.* tool needs an argument you do not have (besides org_id), ask the user for that specific value directly.`,
  ];
  const connected = (input.connectedChannels || []).map((c: any) => {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && c.channel_type) return String(c.channel_type);
    return '';
  }).filter(Boolean);
  if (connected.length > 0) {
    facts.push(
      `- CONNECTED CONNECTORS for this org (authoritative, already OAuth-authorized): ${connected.join(', ')}. Use these tools directly.`,
      `- A tool response saying "not connected" for one connector (e.g. google-drive) does NOT mean other connectors are unavailable — each connector is independent. Verify per-connector by calling its tool.`,
    );
  } else {
    facts.push(
      `- No connectors are confirmed connected for this org yet — do not assume any external connector is available.`,
    );
  }
  if (input.priorToolResults && input.priorToolResults.length > 0) {
    facts.push('', 'PRIOR TOOL RESULTS FROM THIS TASK (do not re-run unless they failed):');
    for (const step of input.priorToolResults.slice(-12)) {
      const toolBit = step.toolUsed ? ` [${step.toolUsed}]` : '';
      facts.push(`- step ${step.step}: ${step.action}${toolBit} → ${String(step.result || '').slice(0, 400)}`);
    }
  }
  facts.push(
    ``,
    `USER REQUEST:`,
    input.userMessage,
  );
  return facts.join('\n');
}

function buildSessionId(input: AgentTaskInput): string {
  if (input.sessionKey) return `darex:${input.orgId}:${input.sessionKey}`;
  if (input.conversationId) return `darex:${input.orgId}:${input.conversationId}`;
  // Rotate the shared fallback daily so an unbounded session can never
  // accumulate forever (an accumulating session is what made Ask AI hang).
  if (input.employeeId) return `darex:${input.orgId}:${input.employeeId}`;
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `darex:${input.orgId}:chat-${day}`;
}

interface SseState {
  reply: string;
  sessionId: string;
  model: string;
  tools: AgentToolStep[];
  errorText: string;
}

class AgentTurnError extends Error {
  partialReply: string;
  toolCallsAttempted: boolean;
  constructor(message: string, partialReply: string, toolCallsAttempted: boolean) {
    super(message);
    this.partialReply = partialReply;
    this.toolCallsAttempted = toolCallsAttempted;
  }
}

export interface RunAgentOptions {
  timeoutMs?: number;
  priorMessages?: { role: string; content: string }[];
  onChunk?: (text: string) => void;
  onToolProgress?: (tool: string, label: string) => void;
}

async function readSseStream(body: ReadableStream<Uint8Array>, sessionId: string, opts?: RunAgentOptions): Promise<AgentTurnResult> {
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
          
          if (payload === '[DONE]') {
            done = true;
            break;
          }
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            newlineIdx = buffer.indexOf('\n');
            continue;
          }

          if (eventType === 'tool_progress' || eventType === 'tool_call' || eventType === 'tool') {
            const toolStr = typeof json.tool === 'string' ? json.tool : (typeof json.name === 'string' ? json.name : 'unknown');
            const labelStr = typeof json.label === 'string' ? json.label : (typeof json.arguments === 'string' ? json.arguments : '');
            state.tools.push({ tool: toolStr, argsLabel: labelStr });
            opts?.onToolProgress?.(toolStr, labelStr);
          } else if (eventType === 'session_id') {
            const sid = json.session_id ?? json.sessionId;
            if (typeof sid === 'string' && sid.length > 0) state.sessionId = sid;
          } else if (eventType === 'error') {
            state.errorText = typeof json.error === 'string' ? json.error : JSON.stringify(json);
          } else {
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              state.reply += delta;
              opts?.onChunk?.(delta);
            }
            const toolCalls = json.choices?.[0]?.delta?.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const toolStr = tc?.function?.name || tc?.name || 'unknown';
                const labelStr = tc?.function?.arguments || '';
                state.tools.push({ tool: String(toolStr), argsLabel: String(labelStr) });
                opts?.onToolProgress?.(String(toolStr), String(labelStr));
              }
            }
            if (typeof json.model === 'string') state.model = json.model;
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    }
  } catch (error: any) {
    if (error.name !== 'AbortError') {
      console.error('[atomic-agent] readSseStream error:', error);
    }
  } finally {
    reader.releaseLock();
  }

  if (state.errorText) {
    throw new AgentTurnError(`Agent loop failed: ${state.errorText}`, state.reply, state.tools.length > 0);
  }
  return {
    reply: state.reply,
    sessionId: state.sessionId || sessionId,
    model: state.model || ATOMIC_AGENT_MODEL,
    tools: state.tools,
  };
}



export async function runAgentTurn(input: AgentTaskInput, opts?: RunAgentOptions): Promise<AgentTurnResult> {
  const sessionId = buildSessionId(input);
  const timeoutMs = opts?.timeoutMs ?? AGENT_TURN_TIMEOUT_MS;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= AGENT_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${ATOMIC_AGENT_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${requireAtomicAgentKey()}`,
          'X-Atomic-Extensions': 'on',
        },
        body: JSON.stringify({
          model: ATOMIC_AGENT_MODEL,
          stream: true,
          session_id: sessionId,
          messages: [
            { role: 'system', content: buildSystemPrompt(input) },
            ...(opts?.priorMessages || []),
            { role: 'user', content: buildGroundedUserMessage(input) },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const msg = `atomic-agent HTTP ${res.status}: ${text.slice(0, 300)}`;
        if (RETRYABLE_HTTP.has(res.status) && attempt < AGENT_MAX_RETRIES) {
          lastErr = new Error(msg);
          controller.abort();
          clearTimeout(timeout);
          await sleepMs(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
          continue;
        }
        throw new Error(msg);
      }
      if (!res.body) throw new Error('atomic-agent returned no response body');

      const result = await readSseStream(res.body, sessionId, opts);
      controller.abort();
      return result;
    } catch (err: any) {
      controller.abort();
      if (err?.name === 'AbortError') {
        throw new Error(`atomic-agent request timed out after ${timeoutMs}ms`);
      }
      lastErr = err;
      clearTimeout(timeout);
      if (attempt >= AGENT_MAX_RETRIES) throw lastErr;
      await sleepMs(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastErr ?? new Error('atomic-agent request failed');
}

export function mapTurnToResult(turn: AgentTurnResult): AgentTaskResult {
  const steps: AgentTaskResult['executedSteps'] = [];
  const usedTools: string[] = [];
  turn.tools.forEach((t, i) => {
    usedTools.push(t.tool);
    steps.push({
      step: i + 1,
      action: `Execute Tool: ${t.tool}`,
      toolUsed: t.tool,
      result: t.argsLabel ? `args: ${t.argsLabel}` : 'tool executed',
    });
  });
  const hasReply = Boolean(turn.reply && turn.reply.trim());
  steps.push({
    step: steps.length + 1,
    action: 'Final Response Synthesis',
    result: hasReply ? `Generated reply: "${turn.reply.slice(0, 60)}..."` : 'Agent turn finished with no text reply',
  });
  return {
    success: true,
    replyMessage: turn.reply,
    executedSteps: steps,
    usedTools,
    // atomic-agent already ran its full MCP tool loop in this turn. Mark done
    // when we have a reply, or when no tools ran (plain Q&A). Empty reply after
    // tools may be an incomplete stream — Temporal can retry with priorToolResults.
    isDone: hasReply || usedTools.length === 0,
  };
}

/**
 * Atomic-agent's internal tool-calling protocol encodes a reply as a JSON
 * envelope like `["reply",{"text":"..."}]`. Some models emit that raw
 * envelope in the content stream instead of plain text, which would otherwise
 * leak the ugly JSON to the user. Detects those envelopes and extracts the
 * human-readable text; returns the original string when there's nothing to
 * unwrap.
 */
export function sanitizeAgentReply(content: string): string {
  if (!content) return content;
  const trimmed = content.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;

  const pickText = (obj: any): string | null => {
    if (obj && typeof obj === 'object') {
      for (const key of ['text', 'content', 'message', 'reply']) {
        if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key].trim();
      }
    }
    return null;
  };

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      const unwrapped = pickText(parsed[1]);
      if (unwrapped) return unwrapped;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const unwrapped = pickText(parsed);
      if (unwrapped) return unwrapped;
    }
  } catch {
    // not JSON — leave the content untouched
  }
  return content;
}

export async function runAutonomousAgentDirect(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTaskResult> {
  try {
    const turn = await runAgentTurn(input, opts);
    turn.reply = sanitizeAgentReply(turn.reply);
    return mapTurnToResult(turn);
  } catch (err: any) {
    console.error('[atomic-agent] Direct execution failed:', err?.message);
    const aborted = err?.name === 'AbortError' || /abort|timed out|timeout/i.test(String(err?.message || ''));
    const partialReply =
      (typeof err?.partialReply === 'string' && err.partialReply.length > 0)
        ? sanitizeAgentReply(err.partialReply)
        : undefined;
    const toolCallsAttempted = Boolean(err?.toolCallsAttempted);
    const details = String(err?.message || 'atomic-agent request failed').replace(/^atomic-agent\s*/i, '');

    let replyMessage = 'I encountered an issue processing your request.';
    if (aborted && toolCallsAttempted) {
      replyMessage =
        'I was working through a tool action but the request timed out — likely a slow external API. ' +
        (partialReply ? `Here is what I had so far:\n\n${partialReply}` : 'Please ask again, and I will retry.');
    } else if (aborted) {
      replyMessage = 'The request timed out before I could respond. Please try again.';
    } else if (toolCallsAttempted && partialReply) {
      replyMessage = `${partialReply}\n\n_Heads up: a tool step hit an error (${details}) — the request could not complete fully._`;
    } else {
      replyMessage = `I encountered an issue processing your request (${details}). Please try again.`;
    }

    return {
      success: false,
      replyMessage,
      executedSteps: [
        {
          step: 1,
          action: 'Agent Turn',
          result: `Failed: ${details}`,
        },
      ],
      usedTools: [],
      error: details,
      partialReply,
      retryable: aborted,
      isDone: !aborted,
    };
  }
}