import { createHmac } from 'node:crypto';
import type { RetrieveMemoryResult } from '@darex/shared-types';
import type { AgentTaskInput, AgentTaskResult } from './agent-engine.js';
import {
  emptyMemoryResult,
  formatRetrievedFactsBlock,
  retrieveMemory,
} from './memory/retrieve.js';
import { buildUnifiedSystemPrompt } from './prompts/system-prompt-builder.js';
import { labelText, readModelText, replyForTurn } from './reply-from-tools.js';
import { recordTurnSpend } from './cost/track.js';
export interface AgentToolStep {
  tool: string;
  argsLabel: string;
  /** Full tool result content when the harness reported one (capped). Falls
   *  back to argsLabel at mapping time when absent (older flows). */
  result?: string;
  /** Child thread that produced this step. Absent on the root agent. */
  threadId?: string;
}

import type { ApprovalRequest, SubagentEvent, TurnUsage } from '@darex/shared-types';
export type { ApprovalRequest, SubagentEvent, TurnUsage } from '@darex/shared-types';

/** In-process mutex so concurrent get-or-create for the same externalId serialize. */
const sessionCreateLocks = new Map<string, Promise<unknown>>();

async function withSessionCreateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionCreateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(
    () => gate,
    () => gate,
  );
  sessionCreateLocks.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sessionCreateLocks.get(key) === tail) {
      sessionCreateLocks.delete(key);
    }
  }
}

/**
 * Pack tool allowlist into a JSON header under maxChars.
 * Dedupes, strips mcp.darex. prefixes for compactness, and logs every drop
 * (never silently truncate).
 */
export function compactAllowlistHeaderJson(
  tools: string[],
  maxChars = 4000,
): { json: string; dropped: string[] } {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of tools) {
    if (typeof raw !== 'string' || !raw) continue;
    const compact = raw.replace(/^mcp\.darex\./i, '');
    if (seen.has(compact)) continue;
    seen.add(compact);
    list.push(compact);
    if (list.length >= 100) break;
  }
  const dropped: string[] = [];
  let json = JSON.stringify(list);
  while (json.length > maxChars && list.length > 0) {
    dropped.push(list.pop()!);
    json = JSON.stringify(list);
  }
  if (dropped.length > 0) {
    const preview = dropped.slice(0, 20).join(', ');
    console.warn(
      `[trueforge] MCP allowlist header exceeds ${maxChars} chars — dropped ${dropped.length} tool(s): ${preview}${dropped.length > 20 ? '…' : ''}`,
    );
  }
  return { json, dropped };
}

export interface AgentTurnResult {
  reply: string;
  sessionId: string;
  model: string;
  tools: AgentToolStep[];
  /** Non-empty when the turn paused for approvals instead of completing. */
  approvals: ApprovalRequest[];
  /** Dynamic-subagent lifecycle, paired by threadId. */
  subagents: SubagentEvent[];
  /** Token/cost/duration footer when the harness reports it. */
  usage?: TurnUsage;
}

export interface ApprovalDecisionInput {
  threadId: string;
  toolCallId: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface RunAgentOptions {
  timeoutMs?: number;
  /** Client disconnect / Stop. Aborts the in-flight model turn. */
  signal?: AbortSignal;
  priorMessages?: { role: string; content: string }[];
  onChunk?: (text: string) => void;
  onToolProgress?: (tool: string, label: string) => void;
  /** Live subagent lifecycle (started/done with threadId, title, instruction). */
  onSubagent?: (ev: SubagentEvent) => void;
  /** Prefetched retrieveMemory result (session/workflow org). Retrieved inside the turn if omitted. */
  retrievedMemory?: RetrieveMemoryResult;
}

const TRUEFORGE_MODEL = process.env.TRUEFORGE_MODEL || 'openrouter/deepseek-v4-1-flash';

function parseTimeoutEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

const AGENT_TURN_TIMEOUT_MS = parseTimeoutEnv('TRUEFORGE_TIMEOUT_MS', 180_000);

export function bindExternalAbort(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}
const SESSION_CREATE_TIMEOUT_MS = parseTimeoutEnv('TRUEFORGE_SESSION_TIMEOUT_MS', 30_000);
const SESSION_DELETE_TIMEOUT_MS = 15_000;

/**
 * Upper bound on tokens one agent turn may request from the provider. Providers
 * reject a request whose allowance exceeds the remaining balance (402), so the
 * model's advertised maximum is not a safe default. Override with AGENT_MAX_OUTPUT_TOKENS.
 */
export function turnOutputTokenCap(modelMax: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_MAX_OUTPUT_TOKENS);
  const cap = Number.isFinite(raw) && raw >= 256 ? Math.floor(raw) : 8192;
  return Math.min(modelMax, cap);
}

/**
 * Automatically seeds or updates the OpenRouter model provider in TrueForge.
 * Includes deepseek-v4-1-flash (under $1/1M tokens, ~$0.15/1M), deepseek free, gemini-2-5-flash.
 */
export async function ensureTrueForgeModelProvider(baseUrl = trueforgeUrl()): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.warn('[trueforge] OPENROUTER_API_KEY is not set — cannot seed model provider');
    return;
  }
  try {
    const res = await fetch(`${baseUrl}/api/v1/settings/model-providers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'custom',
          name: 'openrouter',
          base_url: 'https://openrouter.ai/api/v1',
          auth: { api_key: apiKey },
          models: [
            {
              model_id: 'deepseek/deepseek-v4.1-flash',
              name: 'deepseek-v4-1-flash',
              properties: { context_length: 1048576, max_output_tokens: turnOutputTokenCap(32768) },
            },
            {
              model_id: 'deepseek/deepseek-v4-flash-0731:free',
              name: 'deepseek-v4-flash-free',
              properties: { context_length: 1048576, max_output_tokens: turnOutputTokenCap(32768) },
            },
            {
              model_id: 'google/gemini-2.5-flash',
              name: 'gemini-2-5-flash',
              properties: { context_length: 1048576, max_output_tokens: turnOutputTokenCap(65536) },
            },
            {
              model_id: 'google/gemini-2.5-flash-lite',
              name: 'gemini-2-5-flash-lite',
              properties: { context_length: 1048576, max_output_tokens: turnOutputTokenCap(65536) },
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[trueforge] Failed to configure model provider (${res.status}): ${err}`);
    } else {
      console.info('[trueforge] Successfully ensured OpenRouter model provider configured');
    }
  } catch (err: any) {
    console.warn('[trueforge] Model provider configuration request failed:', err?.message || err);
  }
}

/**
 * Automatically seeds or updates the 'darex' MCP server in TrueForge settings.
 * Ensures the agent harness can connect to the 100 enterprise connector tools.
 */
export async function ensureTrueForgeMcpServer(baseUrl = trueforgeUrl()): Promise<void> {
  const mcpUrl = process.env.MCP_BRIDGE_URL || process.env.ATOMIC_AGENT_MCP_URL || 'http://mcp-bridge:8790/sse';
  try {
    const res = await fetch(`${baseUrl}/api/v1/settings/mcp-servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'remote',
          name: 'darex',
          description: 'DareX enterprise connector and business tools',
          url: mcpUrl,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn(`[trueforge] Failed to configure 'darex' MCP server (${res.status}): ${err}`);
    } else {
      console.info('[trueforge] Successfully ensured "darex" MCP server configured');
    }
  } catch (err: any) {
    console.warn('[trueforge] MCP server configuration request failed:', err?.message || err);
  }
}

/**
 * Ensures the named `darex-ai` agent exists in TrueForge with the correct model
 * and darex MCP server attached. Creates it if absent; updates if the manifest drifts.
 * Called at startup from the worker and from the agent-client auto-seed path.
 */
export async function ensureDarexAgent(baseUrl = trueforgeUrl()): Promise<void> {
  const AGENT_NAME = 'darex-ai';
  const agentModel = process.env.TRUEFORGE_CHAT_MODEL || 'openrouter/claude-3.5-sonnet';
  const instructions =
    process.env.DAREX_AGENT_INSTRUCTIONS ||
    'You are the DareX AI autonomous workforce assistant. You have full access to connected enterprise tools via the darex MCP server. Help the user orchestrate employees, query data, run multi-step actions, and grow their business. Be concise, professional, and action-oriented.';

  const manifest = {
    model: { name: agentModel },
    instructions,
    mcp_servers: [
      {
        name: 'darex',
        enable_tools: ['@all'],
        require_approval_for_tools: ['@write', '@destructive'],
        preload: true,
      },
    ],
    config: {
      iteration_limit: 100,
      sandbox: { enabled: false, file_downloads: true },
      dynamic_sub_agents: { enabled: true },
      context_management: {
        compaction: { enabled: true },
        large_tool_response: { enabled: true },
      },
      generative_ui: { enabled: true },
      ask_user_questions: { enabled: true },
    },
  };

  try {
    // Check if agent already exists
    const listRes = await fetch(`${baseUrl}/api/v1/agents`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (listRes.ok) {
      const listJson = (await listRes.json()) as any;
      const existing = (listJson?.data || []).find((a: any) => a.name === AGENT_NAME);
      if (existing) {
        // Update to ensure manifest is current
        const putRes = await fetch(`${baseUrl}/api/v1/agents/${existing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ manifest }),
          signal: AbortSignal.timeout(10_000),
        });
        if (putRes.ok) {
          console.info('[trueforge] Successfully ensured darex-ai agent manifest is up to date');
        } else {
          const err = await putRes.text().catch(() => '');
          console.warn(`[trueforge] Failed to update darex-ai agent (${putRes.status}): ${err}`);
        }
        return;
      }
    }

    // Create if not found
    const createRes = await fetch(`${baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: AGENT_NAME, manifest }),
      signal: AbortSignal.timeout(10_000),
    });
    if (createRes.ok) {
      console.info('[trueforge] Successfully created darex-ai named agent');
    } else {
      const err = await createRes.text().catch(() => '');
      console.warn(`[trueforge] Failed to create darex-ai agent (${createRes.status}): ${err}`);
    }
  } catch (err: any) {
    console.warn('[trueforge] darex-ai agent seed request failed:', err?.message || err);
  }
}

/** Prod must fail fast — localhost default is dev-only. Validated lazily so
 *  `next build` without env doesn't crash at import time. */
function trueforgeUrl(): string {
  const url = process.env.TRUEFORGE_URL;
  if (!url && process.env.NODE_ENV === 'production') {
    throw new Error('TRUEFORGE_URL must be set in production (in-compose default: http://trueforge:8790)');
  }
  return url || 'http://127.0.0.1:8791';
}

/**
 * Tenant headers forwarded to the MCP bridge (via TrueForge's
 * `x-tfg-mcp-headers` passthrough + top-level `x-org-id`).
 * When MCP_BRIDGE_SECRET is set the payload is HMAC-signed and the bridge
 * verifies it; otherwise the payload is unsigned (dev only — the bridge
 * refuses unsigned traffic in production).
 */
export function buildMcpTenantHeaders(input: AgentTaskInput): Record<string, string> {
  const ts = String(Date.now());
  const { json: allowlistJson } = compactAllowlistHeaderJson(input.toolAllowlist || []);
  const userId = (input as { userId?: unknown }).userId;
  const userIdStr = typeof userId === 'string' ? userId : '';
  const secret = process.env.MCP_BRIDGE_SECRET;
  const role = String(input.employeeRole || '').slice(0, 80);
  const headers: Record<string, string> = {
    'x-org-id': input.orgId,
    'x-ts': ts,
    'x-tool-allowlist': allowlistJson,
  };
  if (userIdStr) headers['x-user-id'] = userIdStr;
  if (role) headers['x-employee-role'] = role;
  if (secret) {
    // v3 binds the employee role so a model cannot swap personas on the bridge.
    // v2 (org.user.ts.allowlist) stays valid for older callers.
    const material = role
      ? `${input.orgId}.${userIdStr}.${ts}.${allowlistJson}.${role}`
      : `${input.orgId}.${userIdStr}.${ts}.${allowlistJson}`;
    headers['x-sig'] = createHmac('sha256', secret)
      .update(material, 'utf8')
      .digest('hex');
  }
  return headers;
}

function buildSystemPrompt(input: AgentTaskInput): string {
  return buildUnifiedSystemPrompt({
    orgId: input.orgId,
    employeeName: input.employeeName,
    employeeRole: input.employeeRole,
    employeePersona: input.employeePersona,
  });
}

export function buildGroundedUserMessage(
  input: AgentTaskInput,
  memory?: RetrieveMemoryResult,
  priorMessages?: { role: string; content: string }[]
): string {
  const parts: string[] = [];

  const connected = (input.connectedChannels || [])
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && c.channel_type) return String(c.channel_type);
      return '';
    })
    .filter(Boolean);

  if (connected.length > 0) {
    parts.push(`CONNECTED INTEGRATIONS: ${connected.join(', ')}`);
  }

  if (priorMessages && priorMessages.length > 0) {
    parts.push('RECENT CONVERSATION HISTORY (in chronological order — use this to answer questions about past messages, user details, and previous context):');
    for (const m of priorMessages.slice(-20)) {
      const who = m.role === 'assistant' ? 'Assistant' : 'User';
      parts.push(`- ${who}: ${String(m.content || '').slice(0, 2000)}`);
    }
  }

  if (input.priorToolResults && input.priorToolResults.length > 0) {
    parts.push('PRIOR TOOL RESULTS FROM THIS WORKFLOW:');
    for (const step of input.priorToolResults.slice(-10)) {
      const toolLabel = step.toolUsed ? ` [${step.toolUsed}]` : '';
      parts.push(`- Step ${step.step}: ${step.action}${toolLabel} -> ${String(step.result || '').slice(0, 500)}`);
    }
  }

  if (memory && memory.citations && memory.citations.length > 0) {
    parts.push(formatRetrievedFactsBlock(memory));
  }

  if (parts.length > 0) {
    parts.push('CURRENT USER MESSAGE — answer this request. The history above is context only; do not answer earlier messages again:');
  }
  parts.push(input.userMessage);
  return parts.join('\n\n');
}

export function sanitizeAgentReply(content: string): string {
  if (!content) return '';
  let cleaned = content.trim();

  // Strip JSON envelope wrappers if the model emitted raw json
  if (cleaned.startsWith('{"text":') && cleaned.endsWith('}')) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.text) return parsed.text;
    } catch {}
  }

  return cleaned;
}

/**
 * Get or create a durable session in TrueForge scoped to the tenant organisation.
 * Concurrent callers for the same externalId share one in-process lock so we
 * never race create/delete/recreate against ourselves.
 */
async function getOrCreateTrueForgeSession(input: AgentTaskInput, depth = 0): Promise<string> {
  if (depth > 1) {
    throw new Error('TrueForge session model mismatch persists after recreate — aborting to avoid loop');
  }
  const baseKey =
    input.conversationId ||
    input.sessionKey ||
    input.employeeId ||
    `chat-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const externalId = `darex:${input.orgId}:${baseKey}`;

  return withSessionCreateLock(externalId, () => createOrHealTrueForgeSession(input, externalId, depth));
}

async function createOrHealTrueForgeSession(
  input: AgentTaskInput,
  externalId: string,
  depth: number,
): Promise<string> {
  const baseUrl = trueforgeUrl();

  const res = await fetch(`${baseUrl}/api/internal/sessions/get-or-create-by-external-id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      external_id: externalId,
      agent: {
        spec: {
          model: {
            name: TRUEFORGE_MODEL,
          },
          instructions: buildSystemPrompt(input),
          mcp_servers: [
            {
              name: 'darex',
              enable_tools: ['@all'],
              require_approval_for_tools:
                process.env.REQUIRE_TOOL_APPROVAL === 'true' || process.env.TRUEFORGE_REQUIRE_WRITE_APPROVAL === 'true'
                  ? ['@write', '@destructive']
                  : ['@destructive'],
              preload: true,
            },
          ],
          config: {
            dynamic_sub_agents: { enabled: true },
            context_management: {
              compaction: { enabled: true },
              large_tool_response: { enabled: true },
            },
          },
        },
      },
    }),
    signal: AbortSignal.timeout(SESSION_CREATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    if (
      res.status === 422 &&
      (errorText.includes('provider not configured') || errorText.includes('not configured on provider')) &&
      depth < 2
    ) {
      console.info('[trueforge] Model provider missing in TrueForge, auto-seeding and retrying...');
      await ensureTrueForgeModelProvider(baseUrl);
      return createOrHealTrueForgeSession(input, externalId, depth + 1);
    }
    if (
      res.status === 422 &&
      (errorText.includes('Unknown MCP server') || errorText.includes('not configured')) &&
      depth < 2
    ) {
      console.info('[trueforge] MCP server missing in TrueForge, auto-seeding and retrying...');
      await ensureTrueForgeMcpServer(baseUrl);
      return createOrHealTrueForgeSession(input, externalId, depth + 1);
    }
    throw new Error(`Failed to initialize TrueForge session (${res.status}): ${errorText}`);
  }

  const json = (await res.json()) as any;
  const sessionData = json?.data;
  if (!sessionData?.id) {
    throw new Error('TrueForge returned session response without session id');
  }

  // Self-heal: if an existing session has stale preload flag, model mismatch, or stale write-approval gating, recreate it
  // Depth-guarded (max 1 retry) so a persistent mismatch can't recurse forever.
  const serverPreload = sessionData.agent?.spec?.mcp_servers?.[0]?.preload;
  const modelName = sessionData.agent?.spec?.model?.name;
  const approvalList = sessionData.agent?.spec?.mcp_servers?.[0]?.require_approval_for_tools || [];
  const needsWriteApproval = process.env.REQUIRE_TOOL_APPROVAL === 'true' || process.env.TRUEFORGE_REQUIRE_WRITE_APPROVAL === 'true';
  const hasWriteApproval = approvalList.includes('@write');
  if (serverPreload === false || (modelName && modelName !== TRUEFORGE_MODEL) || (!needsWriteApproval && hasWriteApproval)) {
    await fetch(`${baseUrl}/api/v1/sessions/${sessionData.id}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS),
    }).catch(() => {});
    return createOrHealTrueForgeSession(input, externalId, depth + 1);
  }

  return sessionData.id;
}

/**
 * Executes a turn (in-process first, then the sidecar) and meters its usage
 * into org_model_spend. Both paths call providers directly, not via LiteLLM,
 * so this is the only place their spend is counted (RT-G01 / RT-B13).
 */
export async function runTrueForgeTurn(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTurnResult> {
  const turn = await runTrueForgeTurnUnmetered(input, opts);
  // Fire-and-forget: recordTurnSpend logs its own failures and must never
  // hold the reply behind a meter write.
  void recordTurnSpend({ orgId: input.orgId, employeeId: input.employeeId, usage: turn.usage });
  return turn;
}

/**
 * Executes a turn via the TrueForge Agent Harness with full streaming support.
 */
async function runTrueForgeTurnUnmetered(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTurnResult> {
  // Core-migration spike: in-process turn first when enabled; any failure
  // (including disabled) falls through to the HTTP sidecar path below.
  try {
    const { runLocalTurn } = await import('./local-turn.js');
    const local = await runLocalTurn(input, opts);
    if (local && (local.reply || local.tools.length > 0)) return local;
  } catch (e) {
    console.warn('[trueforge] local turn unavailable, using HTTP path:', e instanceof Error ? e.message : e);
  }

  const sessionId = await getOrCreateTrueForgeSession(input);

  // Retrieve contextual memory if not prefetched
  let memory = opts?.retrievedMemory;
  if (!memory) {
    try {
      memory = await retrieveMemory({
        orgId: input.orgId,
        query: input.userMessage,
        employeeId: input.employeeId,
        conversationId: input.conversationId,
      });
    } catch (e) {
      memory = emptyMemoryResult(input.orgId);
    }
  }

  const priorMsgs = opts?.priorMessages || (input as any).priorMessages;
  const groundedMessage = buildGroundedUserMessage(input, memory, priorMsgs);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts?.timeoutMs || AGENT_TURN_TIMEOUT_MS);
  const unbindAbort = bindExternalAbort(controller, opts?.signal);
  const tenantHeaders = buildMcpTenantHeaders(input);
  const sink = createTurnSink(opts);

  try {
    const turnRes = await fetch(`${trueforgeUrl()}/api/v1/sessions/${sessionId}/turns`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-org-id': input.orgId,
        'x-tfg-mcp-headers': JSON.stringify({ darex: tenantHeaders }),
      },
      body: JSON.stringify({
        input: [
          {
            type: 'user.message',
            content: groundedMessage,
          },
        ],
        stream: true,
      }),
    });

    if (!turnRes.ok || !turnRes.body) {
      const errText = await turnRes.text().catch(() => '');
      if (
        turnRes.status === 422 &&
        errText.includes('user message cannot be sent while approvals or questions are pending')
      ) {
        console.warn(`[trueforge] Session ${sessionId} has pending approvals/questions blocking user message. Recreating session to unblock...`);
        await fetch(`${trueforgeUrl()}/api/v1/sessions/${sessionId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(SESSION_DELETE_TIMEOUT_MS),
        }).catch(() => {});
        const freshSessionId = await getOrCreateTrueForgeSession(input, 1);
        const retryRes = await fetch(`${trueforgeUrl()}/api/v1/sessions/${freshSessionId}/turns`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-org-id': input.orgId,
            'x-tfg-mcp-headers': JSON.stringify({ darex: tenantHeaders }),
          },
          body: JSON.stringify({
            input: [
              {
                type: 'user.message',
                content: groundedMessage,
              },
            ],
            stream: true,
          }),
        });
        if (!retryRes.ok || !retryRes.body) {
          const retryErr = await retryRes.text().catch(() => '');
          throw new Error(`TrueForge turn creation failed after approval unblock (${retryRes.status}): ${retryErr}`);
        }
        await readTurnStream(retryRes.body, sink);
        return {
          reply: sanitizeAgentReply(sink.reply),
          sessionId: freshSessionId,
          model: TRUEFORGE_MODEL,
          tools: sink.tools,
          approvals: sink.approvals,
          subagents: sink.subagents,
          usage: sink.usage,
        };
      }
      throw new Error(`TrueForge turn creation failed (${turnRes.status}): ${errText}`);
    }

    await readTurnStream(turnRes.body, sink);

    return {
      reply: sanitizeAgentReply(sink.reply),
      sessionId,
      model: TRUEFORGE_MODEL,
      tools: sink.tools,
      approvals: sink.approvals,
      subagents: sink.subagents,
      usage: sink.usage,
    };
  } finally {
    clearTimeout(timeoutId);
    unbindAbort();
  }
}

/** Mutable accumulation state for one streamed turn (initial + resume). */
interface TurnSink {
  reply: string;
  tools: AgentToolStep[];
  approvals: ApprovalRequest[];
  subagents: SubagentEvent[];
  usage?: TurnUsage;
  /** tool_call_id → model-announced tool name (delta events precede responses). */
  callIdToName: Map<string, string>;
  /** thread_id → started-at ms (pairs created/done for durations). */
  subagentStart: Map<string, number>;
  createdAt: number;
  opts?: RunAgentOptions;
}

function createTurnSink(opts?: RunAgentOptions): TurnSink {
  return {
    reply: '',
    tools: [],
    approvals: [],
    subagents: [],
    callIdToName: new Map(),
    subagentStart: new Map(),
    createdAt: Date.now(),
    opts,
  };
}

function readMetricNumber(metrics: unknown, camel: string, snake: string): number | undefined {
  if (typeof metrics !== 'object' || metrics == null) return undefined;
  const rec = metrics as Record<string, unknown>;
  const camelValue = rec[camel];
  if (typeof camelValue === 'number' && Number.isFinite(camelValue)) return camelValue;
  const snakeValue = rec[snake];
  return typeof snakeValue === 'number' && Number.isFinite(snakeValue) ? snakeValue : undefined;
}

/** Token/cost block from turn.done state (camelCase or snake_case). */
function readTurnUsage(event: any, startedAt: number): TurnUsage | undefined {
  const metrics = event?.state?.metrics;
  if (typeof metrics !== 'object' || metrics == null) {
    return { durationMs: Math.max(0, Date.now() - startedAt) };
  }
  const input = readMetricNumber(metrics, 'totalInputTokens', 'total_input_tokens');
  const output = readMetricNumber(metrics, 'totalOutputTokens', 'total_output_tokens');
  const cacheRead = readMetricNumber(metrics, 'totalCacheReadTokens', 'total_cache_read_tokens');
  const cacheWrite = readMetricNumber(metrics, 'totalCacheWriteTokens', 'total_cache_write_tokens');
  const cached = cacheRead !== undefined || cacheWrite !== undefined
    ? (cacheRead ?? 0) + (cacheWrite ?? 0)
    : undefined;
  const usage: TurnUsage = {
    totalTokens: readMetricNumber(metrics, 'totalTokens', 'total_tokens')
      ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined),
    inputTokens: input !== undefined && cached !== undefined ? Math.max(0, input - cached) : input,
    outputTokens: output,
    cachedTokens: cached,
    totalCostInUsd: readMetricNumber(metrics, 'totalCostInUsd', 'total_cost_in_usd'),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  return usage;
}

function resolveSinkToolName(sink: TurnSink, event: any): string {
  const callId = typeof event?.tool_call_id === 'string' ? event.tool_call_id : '';
  if (callId && sink.callIdToName.has(callId)) return sink.callIdToName.get(callId) as string;
  const direct = event?.tool_name || event?.toolName;
  if (typeof direct === 'string' && direct && direct !== 'tool') return direct;
  return 'tool';
}

/** Single-event handler shared by initial turns and approval resumes. */
function handleTurnEvent(event: any, sink: TurnSink): void {
  const { opts } = sink;
  const { tools, approvals } = sink;

  // 1. Streaming tokens
  if (event.type === 'model.message.delta' && typeof event.content === 'string') {
    sink.reply += event.content;
    opts?.onChunk?.(event.content);
  }

  // 2. Tool calls (also records call ids for later response/approval mapping)
  if (event.type === 'model.message.delta' && Array.isArray(event.tool_calls)) {
    for (const tc of event.tool_calls) {
      const toolName = tc.function?.name || tc.tool_info?.name || 'tool';
      const toolArgs = labelText(tc.function?.arguments);
      if (typeof tc.id === 'string' && tc.id) sink.callIdToName.set(tc.id, toolName);
      tools.push({ tool: toolName, argsLabel: toolArgs, ...(typeof event.thread_id === 'string' ? { threadId: event.thread_id } : {}) });
      opts?.onToolProgress?.(toolName, toolArgs);
    }
  }

  // 3. Tool response — attach the FULL result (capped) so retries
  // and priorToolResults feed actual outputs, not just arg labels.
  if (event.type === 'tool.response') {
    const toolName = resolveSinkToolName(sink, event);
    const full = readModelText(event.content) || (event.content != null ? labelText(event.content) : '');
    const summary = full.slice(0, 100);
    const eventThreadId = typeof event.thread_id === 'string' ? event.thread_id : undefined;
    const step: AgentToolStep = { tool: toolName, argsLabel: summary, ...(eventThreadId ? { threadId: eventThreadId } : {}) };
    if (full) step.result = full.slice(0, 4000);
    // Merge into the matching pending call entry when possible so
    // executedSteps doesn't double-count call + response.
    const pending = [...tools].reverse().find((t) => t.tool === toolName && !t.result && (!eventThreadId || t.threadId === eventThreadId || !t.threadId));
    if (pending && full) {
      pending.result = full.slice(0, 4000);
      if (eventThreadId && !pending.threadId) pending.threadId = eventThreadId;
    } else tools.push(step);
    opts?.onToolProgress?.(toolName, summary);
  }

  // 3b. Approval gate — TrueForge pauses mid-turn with
  // `tool.approval_required` (or legacy `user-input-required`) for tools
  // tagged @write/@destructive. Capture thread/call ids so the dashboard can
  // resume via resumeTrueForgeTurn; also surface a first-class step so the
  // turn never looks hung.
  if (event.type === 'tool.approval_required') {
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : '';
    const refs = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    for (const ref of refs) {
      const callId = typeof ref?.id === 'string' ? ref.id : '';
      const name = (callId && sink.callIdToName.get(callId)) || 'tool';
      if (threadId && callId) approvals.push({ threadId, toolCallId: callId, toolName: name });
      const label = `${name} needs approval${threadId ? ` (${threadId.slice(0, 8)})` : ''}`;
      tools.push({ tool: 'approval_required', argsLabel: label });
      opts?.onToolProgress?.('approval_required', label);
    }
    if (refs.length === 0) {
      tools.push({ tool: 'approval_required', argsLabel: 'approval paused the turn' });
      opts?.onToolProgress?.('approval_required', 'approval paused the turn');
    }
  } else if (typeof event.type === 'string' &&
    (event.type === 'user-input-required' || event.type.includes('approval'))) {
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : '';
    const callId = typeof event.tool_call_id === 'string'
      ? event.tool_call_id
      : typeof event.call_id === 'string'
        ? event.call_id
        : typeof event.id === 'string'
          ? event.id
          : '';
    const toolName = typeof event.tool_name === 'string'
      ? event.tool_name
      : typeof event.toolName === 'string'
        ? event.toolName
        : (callId && sink.callIdToName.get(callId)) || 'tool';
    if (threadId && callId) {
      approvals.push({ threadId, toolCallId: callId, toolName });
    }
    const label = typeof event.content === 'string'
      ? event.content.slice(0, 300)
      : JSON.stringify({
        tool: toolName,
        state: event.state || null,
      }).slice(0, 300);
    tools.push({ tool: 'approval_required', argsLabel: label });
    opts?.onToolProgress?.('approval_required', label);
  }

  // 4. Dynamic Subagent Lifecycle Events. NOTE: the schema field is `title`
  // (plus agent_info {name, input, model}); older code read `event.name`
  // which never exists — always fell back to 'subagent'.
  if (event.type === 'thread.created') {
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : '';
    const info = (event.agent_info && typeof event.agent_info === 'object' ? event.agent_info : {}) as Record<string, unknown>;
    const name = typeof info.name === 'string' && info.name
      || typeof event.title === 'string' && event.title
      || 'subagent';
    const instruction = typeof info.text === 'string' ? info.text
      : typeof info.input === 'string' ? info.input : '';
    const model = typeof info.model === 'string' ? info.model : undefined;
    const title = typeof event.title === 'string' ? event.title : name;
    const now = Date.now();
    if (threadId) sink.subagentStart.set(threadId, now);
    const subEv: SubagentEvent = {
      threadId,
      title,
      name,
      instruction: instruction.slice(0, 2000),
      ...(model ? { model } : {}),
      status: 'started',
      createdAt: new Date(now).toISOString(),
    };
    sink.subagents.push(subEv);
    opts?.onSubagent?.(subEv);
    // Keep the legacy flat step + progress so old clients still narrate.
    tools.push({ tool: 'subagent_start', argsLabel: name, ...(threadId ? { threadId } : {}) });
    opts?.onToolProgress?.('subagent_start', `Started subagent: ${name}`);
  }

  if (event.type === 'thread.done') {
    const threadId = event.thread_id ? String(event.thread_id) : '';
    const startedAt = threadId ? sink.subagentStart.get(threadId) : undefined;
    const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
    const prior = threadId ? [...sink.subagents].reverse().find((s) => s.threadId === threadId && s.status === 'started') : undefined;
    const doneEv: SubagentEvent = {
      threadId,
      title: prior?.title || threadId.slice(0, 8),
      name: prior?.name || threadId.slice(0, 8),
      instruction: prior?.instruction || '',
      ...(prior?.model ? { model: prior.model } : {}),
      status: 'done',
      ...(durationMs !== undefined ? { durationMs } : {}),
      createdAt: new Date().toISOString(),
    };
    sink.subagents.push(doneEv);
    opts?.onSubagent?.(doneEv);
    if (threadId) sink.subagentStart.delete(threadId);
    tools.push({ tool: 'subagent_done', argsLabel: threadId, result: threadId, ...(threadId ? { threadId } : {}) });
    opts?.onToolProgress?.('subagent_done', `Completed subagent execution`);
  }

  // 5. Turn completion
  if (event.type === 'turn.done') {
    if (event.state?.status === 'error') {
      const errMsg = event.state.message || 'Turn completed with error status';
      throw new Error(`TrueForge execution error: ${errMsg}`);
    }
    sink.usage = readTurnUsage(event, sink.createdAt);
    if (!sink.reply && event.state?.output?.content) {
      sink.reply = readModelText(event.state.output.content);
      if (sink.reply) opts?.onChunk?.(sink.reply);
    }
  }
}

function parseTurnPayload(payload: string, sink: TurnSink): void {
  if (!payload || payload === '[DONE]') return;
  let event: any;
  try {
    event = JSON.parse(payload);
  } catch {
    // Ignore non-json SSE lines — but callback errors inside handleTurnEvent
    // must propagate so a disconnected client aborts the turn promptly.
    return;
  }
  handleTurnEvent(event, sink);
}

/** Shared SSE reader: newline-delimited `data:` frames plus a trailing tail
 *  frame. Throws on turn error status so callers fail the turn uniformly. */
async function readTurnStream(body: ReadableStream<Uint8Array>, sink: TurnSink): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIdx = buffer.indexOf('\n');

    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, '').trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.startsWith('data:')) parseTurnPayload(line.slice(5).trim(), sink);
      newlineIdx = buffer.indexOf('\n');
    }
  }

  // A final event without a trailing newline would otherwise be dropped.
  const tail = buffer.replace(/\r$/, '').trim();
  if (tail.startsWith('data:')) {
    try {
      parseTurnPayload(tail.slice(5).trim(), sink);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('TrueForge execution error:')) throw e;
    }
  }
}

export interface ResumeTurnInput {
  /** TrueForge session UUID from a previous turn result. */
  sessionId: string;
  /** Tenant — re-resolved server-side from the dashboard session, never trusted from the client. */
  orgId: string;
  userId?: string;
  toolAllowlist?: string[];
  decisions: ApprovalDecisionInput[];
}

/**
 * Resume a turn paused on `tool.approval_required` by posting
 * `user.tool_approval` items into the SAME session and streaming the
 * continuation. Tenant headers are re-signed here, so a stolen sessionId
 * alone authorizes nothing (the bridge still verifies HMAC per tool call).
 */
export async function resumeTrueForgeTurn(
  input: ResumeTurnInput,
  opts?: RunAgentOptions,
): Promise<AgentTurnResult> {
  return resumeTrueForgeTurnInner(input, opts);
}

async function resumeTrueForgeTurnInner(
  input: ResumeTurnInput,
  opts?: RunAgentOptions,
): Promise<AgentTurnResult> {
  if (!input.sessionId || !input.decisions.length) {
    throw new Error('resumeTrueForgeTurn requires sessionId and at least one decision');
  }

  try {
    const { resumeLocalTurn } = await import('./local-turn.js');
    const local = await resumeLocalTurn(input, opts);
    if (local) return local;
  } catch (e) {
    console.warn('[trueforge] local resume unavailable, falling back to HTTP:', e instanceof Error ? e.message : e);
  }
  const tenantHeaders = buildMcpTenantHeaders({
    orgId: input.orgId,
    userId: input.userId,
    toolAllowlist: input.toolAllowlist || [],
  } as AgentTaskInput);
  const sink = createTurnSink(opts);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts?.timeoutMs || AGENT_TURN_TIMEOUT_MS);
  const unbindAbort = bindExternalAbort(controller, opts?.signal);

  try {
    const turnRes = await fetch(`${trueforgeUrl()}/api/v1/sessions/${input.sessionId}/turns`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-org-id': input.orgId,
        'x-tfg-mcp-headers': JSON.stringify({ darex: tenantHeaders }),
      },
      body: JSON.stringify({
        input: input.decisions.map((d) => ({
          type: 'user.tool_approval',
          thread_id: d.threadId,
          tool_call_id: d.toolCallId,
          approval: d.decision === 'allow'
            ? { status: 'allow' }
            : { status: 'deny', reason: d.reason || 'Denied by user' },
        })),
        stream: true,
      }),
    });

    if (!turnRes.ok || !turnRes.body) {
      const errText = await turnRes.text().catch(() => '');
      throw new Error(`TrueForge resume failed (${turnRes.status}): ${errText}`);
    }

    await readTurnStream(turnRes.body, sink);
    // Sidecar resume reports per-turn usage; local resume reports cumulative
    // thread metrics, so only this path is metered here (RT-G01).
    void recordTurnSpend({ orgId: input.orgId, usage: sink.usage });
    return {
      reply: sanitizeAgentReply(sink.reply),
      sessionId: input.sessionId,
      model: TRUEFORGE_MODEL,
      tools: sink.tools,
      approvals: sink.approvals,
      subagents: sink.subagents,
      usage: sink.usage,
    };
  } finally {
    clearTimeout(timeoutId);
    unbindAbort();
  }
}

/**
 * Standard entrypoint matching the Darex Agent Harness interface.
 */
export async function runAgentTurn(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTurnResult> {
  return runTrueForgeTurn(input, opts);
}

/**
 * Direct execution wrapper mapping AgentTurnResult to AgentTaskResult.
 */
export async function runAutonomousAgentDirect(
  input: AgentTaskInput,
  opts?: RunAgentOptions
): Promise<AgentTaskResult> {
  try {
    const turn = await runAgentTurn(input, opts);
    const toolSteps = turn.tools.map((t) => ({ tool: t.tool, result: t.result, argsLabel: t.argsLabel }));
    // Prefer a tool-grounded reply when the model left a placeholder. Do not
    // onChunk it — chunks already streamed the model text; the ask-ai `done`
    // event (or Temporal result) carries the final replyMessage so the
    // client replaces instead of appending a second full answer.
    const replyMessage = replyForTurn(sanitizeAgentReply(turn.reply), toolSteps);

    return {
      success: true,
      replyMessage,
      executedSteps: turn.tools.map((t, idx) => ({
        step: idx + 1,
        action: t.tool,
        toolUsed: t.tool,
        result: t.result || t.argsLabel,
      })),
      usedTools: Array.from(new Set(turn.tools.map((t) => t.tool))),
      isDone: turn.approvals.length === 0,
      sessionId: turn.sessionId,
      approvals: turn.approvals.length > 0 ? turn.approvals : undefined,
      subagents: turn.subagents.length > 0 ? turn.subagents : undefined,
      usage: turn.usage,
    };
  } catch (err: any) {
    console.error('[trueforge] Turn execution failed:', err?.message);
    const details = String(err?.message || 'TrueForge agent execution failed');
    // Timeouts/aborts are transient — mark retryable so the Temporal retry
    // loop (AutonomousAgentWorkflow) and activity mapping can retry instead
    // of saving a failure as final.
    const retryable = /abort|timeout|timed out|ECONNRESET|fetch failed|temporarily/i.test(details);

    return {
      success: false,
      replyMessage: `I encountered an issue while processing your request: ${details}`,
      executedSteps: [
        {
          step: 1,
          action: 'TrueForge Agent Turn',
          result: `Error: ${details}`,
        },
      ],
      usedTools: [],
      error: details,
      retryable,
      isDone: true,
    };
  }
}
