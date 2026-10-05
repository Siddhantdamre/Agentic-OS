/**
 * In-process TrueForge turn — Native Multi-Tenant Execution Harness.
 *
 * Runs the `@truefoundry/trueforge-core` turn loop directly INSIDE DareX:
 * - Multi-tenant isolation: tenant (orgId, userId) is bound at construction in memory;
 * - Tools: all 96 DareX connector tools (Gmail, Calendar, WhatsApp, SQL, HubSpot, etc.)
 *   execute directly through `executeAutonomousToolAction` with zero HTTP/SSE overhead;
 * - Full TrueForge built-in capabilities:
 *   * CurrentDateTime (real-world time grounding via get_current_datetime)
 *   * AskUserQuestion (human-in-the-loop interactive clarification)
 *   * DynamicSubAgents (parallel & sequential subagent delegation with SUB_AGENT_IDENTITY)
 *   * OpenUI (generative interactive UI components)
 *   * ContextCompaction (intelligent history summarization at token thresholds)
 *   * LargeToolResponse (truncation, preview, and subagent delegation guidance)
 * - Real-time streaming: tokens, tool calls, subagents, and completion metrics stream directly to Ask AI.
 */
import { z } from 'zod';
import { labelText, readModelText } from './reply-from-tools.js';
import { bindExternalAbort } from './trueforge-client.js';
import {
  AgentThread,
  AgentThreadOrchestrator,
  contextCompaction,
  currentDateTime,
  dynamicSubAgents,
  EventType,
  largeToolResponse,
  openUI,
  SUB_AGENT_IDENTITY,
  toolResultResponse,
  VercelAILLM,
} from '@truefoundry/trueforge-core/core';
import type {
  AgentDefinition,
  AgentTracing,
  CreateDynamicSubAgentThread,
  IToolSet,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalRequest, SubagentEvent, TurnUsage } from '@darex/shared-types';
import type { AgentTaskInput } from './agent-engine.js';
import {
  buildGroundedUserMessage,
  type AgentToolStep,
  type AgentTurnResult,
  type RunAgentOptions,
  type ResumeTurnInput,
} from './trueforge-client.js';
import { executeAutonomousToolAction, resolveToolRisk, type ToolRisk } from './tool-executor.js';
import { emptyMemoryResult, retrieveMemory } from './memory/retrieve.js';
import { TOOLS, type ToolDef } from './tool-definitions.js';
import { resolveLocalToolInvocation, selectToolsForLocalTurn } from './local-tool-select.js';
import { buildUnifiedSystemPrompt } from './prompts/system-prompt-builder.js';
import { sanitizeToolOutput } from './guardrails/tool-sanitizer.js';
import {
  isProviderAvailable,
  recordProviderFailure,
  recordProviderSuccess,
} from './circuit-breaker.js';

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function inprocessTurnsEnabled(): boolean {
  return process.env.DAREX_INPROCESS_TURNS !== 'false';
}

/** Active in-process orchestrator sessions for approval resumption. */
interface ActiveLocalSession {
  sessionId: string;
  orchestrator: AgentThreadOrchestrator;
  rootThreadId: string;
  rootThread: AgentThread;
  input: AgentTaskInput;
  tools: AgentToolStep[];
  subagents: SubagentEvent[];
  callIdToName: Map<string, string>;
  createdAt: number;
}
const activeLocalOrchestrators = new Map<string, ActiveLocalSession>();
const MAX_LOCAL_SESSIONS = 500;

function putLocalSession(sessionId: string, sess: ActiveLocalSession): void {
  if (activeLocalOrchestrators.size >= MAX_LOCAL_SESSIONS) {
    // Evict oldest by createdAt
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, value] of activeLocalOrchestrators) {
      if (value.createdAt < oldestAt) {
        oldestAt = value.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey) activeLocalOrchestrators.delete(oldestKey);
  }
  activeLocalOrchestrators.set(sessionId, sess);
}

// Cleanup stale sessions older than 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, sess] of activeLocalOrchestrators.entries()) {
    if (now - sess.createdAt > 30 * 60 * 1000) {
      activeLocalOrchestrators.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

export interface LocalModelCandidate {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Model candidate endpoints for in-process turns in priority order.
 * Ensures robust failover across Gemini, Groq, OpenRouter, and LiteLLM.
 */
export function getLocalModelCandidates(): LocalModelCandidate[] {
  const isDocker = existsSync('/.dockerenv');
  const normalizeBase = (url: string) => {
    let b = url.replace(/\/$/, '');
    if (isDocker && (b.includes('localhost:4000') || b.includes('127.0.0.1:4000'))) {
      b = b.replace(/localhost:4000|127\.0\.0\.1:4000/, 'darex-litellm:4000');
    } else if (!isDocker && (b.includes('//litellm:4000') || b.includes('//darex-litellm:4000'))) {
      b = b.replace(/\/\/(litellm|darex-litellm):4000/, '//127.0.0.1:4000');
    }
    return b;
  };

  const candidates: LocalModelCandidate[] = [];

  // 1. Explicit override (DAREX_LOCAL_MODEL_BASE_URL)
  const overrideBase = process.env.DAREX_LOCAL_MODEL_BASE_URL;
  if (overrideBase) {
    candidates.push({
      name: 'override',
      baseUrl: normalizeBase(overrideBase),
      apiKey: process.env.DAREX_LOCAL_MODEL_API_KEY || '',
      model: process.env.DAREX_LOCAL_MODEL || 'google/gemini-2.5-flash',
    });
  }

  // 2. Direct Gemini (Google Generative Language OpenAI-compatible endpoint)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    let model = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
    if (model === 'gemini-2.0-flash' || model === 'gemini-1.5-flash') {
      model = 'gemini-2.5-flash';
    }
    candidates.push({
      name: 'gemini',
      baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: geminiKey,
      model,
    });
    // Add flash-lite fallback candidate for quota exhaustion resilience
    if (model !== 'gemini-2.5-flash-lite' && model !== 'gemini-3.5-flash-lite') {
      candidates.push({
        name: 'gemini-lite',
        baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: geminiKey,
        model: 'gemini-3.5-flash-lite',
      });
    }
  }

  // 3. Direct Groq
  if (process.env.GROQ_API_KEY) {
    let model = process.env.GROQ_CHAT_MODEL || 'qwen/qwen3.8-27b';
    if (model.includes('llama-3.3') || model.includes('llama3.3')) {
      model = 'qwen/qwen3.8-27b';
    }
    candidates.push({
      name: 'groq',
      baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
      apiKey: process.env.GROQ_API_KEY,
      model,
    });
  }

  // 4. Direct OpenRouter
  if (process.env.OPENROUTER_API_KEY) {
    let model = process.env.OPENROUTER_MODEL || process.env.TRUEFORGE_MODEL || 'qwen/qwen3.8-27b:free';
    if (model.includes(',')) model = model.split(',')[0].trim();
    if (model.startsWith('openrouter/')) {
      model = model.replace('openrouter/', '');
      if (model === 'deepseek-v4-1-flash') model = 'deepseek/deepseek-v4.1-flash';
      else if (model === 'deepseek-v4-flash-free') model = 'deepseek/deepseek-v4-flash-0731:free';
      else if (model === 'gemini-2-5-flash') model = 'google/gemini-2.5-flash';
      else if (model === 'gemini-2-5-flash-lite') model = 'google/gemini-2.5-flash-lite';
      else if (!model.includes('/')) model = `google/${model}`;
    }
    candidates.push({
      name: 'openrouter',
      baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      model,
    });
  }

  // If TRUEFORGE_MODEL explicitly configures OpenRouter, prioritize it over Gemini/Groq
  const prefersOpenRouter =
    process.env.TRUEFORGE_MODEL?.startsWith('openrouter/') ||
    process.env.TRUEFORGE_CHAT_MODEL?.startsWith('openrouter/');
  if (prefersOpenRouter) {
    const orIdx = candidates.findIndex((c) => c.name === 'openrouter');
    if (orIdx > 0) {
      const [orCandidate] = candidates.splice(orIdx, 1);
      const insertAt = candidates[0]?.name === 'override' ? 1 : 0;
      candidates.splice(insertAt, 0, orCandidate);
    }
  }

  // 5. LiteLLM proxy
  const litellmBase = process.env.LITELLM_BASE_URL;
  const litellmKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
  if (litellmBase && litellmKey) {
    const base = normalizeBase(litellmBase);
    const litellmCandidate: LocalModelCandidate = {
      name: 'litellm',
      baseUrl: base.endsWith('/v1') ? base : `${base}/v1`,
      apiKey: litellmKey,
      model: process.env.LITELLM_MODEL || 'darex-default',
    };
    if (isDocker) {
      candidates.unshift(litellmCandidate);
    } else {
      candidates.push(litellmCandidate);
    }
  }

  return candidates;
}

/**
 * Primary model endpoint for in-process turns.
 */
export function localModelConfig(): LocalModelCandidate {
  const candidates = getLocalModelCandidates();
  if (candidates.length > 0) return candidates[0];

  const isProd = process.env.NODE_ENV === 'production';
  const fallbackKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (isProd && !fallbackKey && !process.env.OPENROUTER_API_KEY && !process.env.DAREX_LOCAL_MODEL_API_KEY && !process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error('LITELLM_API_KEY (or GEMINI_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY) must be set in production');
  }
  const isDocker = existsSync('/.dockerenv');
  const base = process.env.LITELLM_BASE_URL || (isProd ? '' : (isDocker ? 'http://darex-litellm:4000' : 'http://127.0.0.1:4000'));
  return {
    name: 'default',
    baseUrl: base ? (base.endsWith('/v1') ? base : `${base}/v1`) : '',
    apiKey: fallbackKey,
    model: process.env.LITELLM_MODEL || 'darex-default',
  };
}

/** No-op tracing for in-process turns (route-level Langfuse handles tracing). */
const noopTracing: AgentTracing = {
  withInitSpan: (op) => op(),
  startRootSpan: () => ({
    runInContext: (op) => op(),
    startSubAgent: () => noopExecTrace,
    setOutput: () => undefined,
    setMetrics: () => undefined,
    setError: () => undefined,
    setSuccess: () => undefined,
    end: () => undefined,
  }),
  withLocalToolSpan: (_input, op) =>
    op({ setOutput: () => undefined, setSandboxId: () => undefined }),
  withRemoteMcpToolSpan: (_input, op) =>
    op({ setOutput: () => undefined, setNumberOfTools: () => undefined }),
};

const noopExecTrace = {
  runInContext: <T>(op: () => T): T => op(),
  startSubAgent: () => noopExecTrace,
  setOutput: () => undefined,
  setMetrics: () => undefined,
  setError: () => undefined,
  setSuccess: () => undefined,
  end: () => undefined,
};

/** Minimal winston-compatible logger for AgentThread. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLogger(): any {
  const sink = (...args: unknown[]) => {
    if (process.env.DAREX_INPROCESS_DEBUG) console.debug('[local-turn]', ...args);
  };
  const self: Record<string, unknown> = {
    child: () => self,
    info: sink,
    warn: (...a: unknown[]) => console.warn('[local-turn]', ...a),
    error: (...a: unknown[]) => console.error('[local-turn]', ...a),
    debug: sink,
  };
  return self;
}

/** Converts a Zod type definition into a JSON Schema node. */
function zodToJsonSchemaNode(zodType: z.ZodTypeAny): { schema: Record<string, any>; isOptional: boolean } {
  let isOptional = false;
  let curr: any = zodType;
  while (curr instanceof z.ZodOptional || curr instanceof z.ZodNullable) {
    if (curr instanceof z.ZodOptional) isOptional = true;
    curr = curr._def.innerType;
  }
  const schema: Record<string, any> = {};
  if (curr instanceof z.ZodString) {
    schema.type = 'string';
  } else if (curr instanceof z.ZodNumber) {
    schema.type = 'number';
  } else if (curr instanceof z.ZodBoolean) {
    schema.type = 'boolean';
  } else if (curr instanceof z.ZodEnum) {
    schema.type = 'string';
    schema.enum = curr._def.values;
  } else if (curr instanceof z.ZodArray) {
    schema.type = 'array';
    schema.items = zodToJsonSchemaNode(curr._def.type).schema;
  } else {
    schema.type = 'string';
  }
  if (curr.description) schema.description = curr.description;
  return { schema, isOptional };
}

/** Converts a ToolDef's schema to a standard JSON Schema object, stripping org_id for tenancy safety. */
function toolDefToJsonSchema(toolDef: ToolDef): {
  type: 'object';
  properties: Record<string, object>;
  required?: string[];
} {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, zodType] of Object.entries(toolDef.schema)) {
    if (key === 'org_id') continue;
    const { schema, isOptional } = zodToJsonSchemaNode(zodType);
    properties[key] = schema;
    if (!isOptional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Determines whether a tool call requires human approval (ASK-S05).
 * Confirm-class actions (pay, send, sign, publish, delete, execute) require approval unconditionally.
 * General writes/mutations default to requiring approval unless explicitly disabled (REQUIRE_TOOL_APPROVAL='false').
 * Read operations never require approval.
 */
export function isToolApprovalRequired(params: {
  toolName: string;
  toolDef?: ToolDef;
  riskMeta?: { risk: ToolRisk; confirm: boolean } | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  const riskMeta = params.riskMeta;
  const def = params.toolDef;
  const risk = riskMeta?.risk ?? (def?.risk as ToolRisk | undefined);

  // Irreversible / high-risk actions that MUST require human approval by default
  const isConfirmClass =
    riskMeta?.confirm === true ||
    def?.confirm === true ||
    (risk !== undefined && ['pay', 'send', 'sign', 'publish', 'delete', 'execute'].includes(risk)) ||
    /^(terminal|bash|python|code_execution|sandbox|file_ops_delete|db_execute)/i.test(params.toolName) ||
    /delete|execute|charge|refund|payout|transfer|send/i.test(params.toolName);

  if (isConfirmClass) {
    return env.REQUIRE_DESTRUCTIVE_APPROVAL !== 'false';
  }

  // General mutations / writes
  const isWrite =
    (risk !== undefined && risk !== 'read') ||
    def?.risk === 'draft' ||
    /write|update|insert|create|post|put|patch/i.test(params.toolName);

  if (isWrite) {
    return env.REQUIRE_TOOL_APPROVAL !== 'false';
  }

  return false;
}

/**
 * Validate model-supplied tool arguments against the tool's zod shape before
 * anything executes (RT-B06). Malformed JSON or a schema mismatch goes back
 * to the model as an error instead of silently becoming `{}` and running the
 * tool on defaults. `org_id` is never model-supplied (tenant comes from the
 * session), explicit nulls count as "not provided", and unknown keys pass
 * through for modules that read extra fields.
 */
export function parseToolArguments(
  def: Pick<ToolDef, 'name' | 'schema'>,
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  let value: unknown = raw ?? {};
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) value = {};
    else {
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, error: `Arguments for ${def.name} were not valid JSON. Nothing was executed; re-issue the call with a JSON object.` };
      }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `Arguments for ${def.name} must be a JSON object. Nothing was executed.` };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'org_id' || v === null) continue;
    args[k] = v;
  }
  const shape: Record<string, z.ZodTypeAny> = { ...def.schema };
  delete shape.org_id;
  const result = z.object(shape).passthrough().safeParse(args);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid arguments for ${def.name}: ${issues}. Nothing was executed.` };
  }
  return { ok: true, args: result.data as Record<string, unknown> };
}

/** Max tool calls (root + subagents) in one in-process turn (RT-B08). */
export const LOCAL_TURN_MAX_TOOL_CALLS = (() => {
  const n = parseInt(process.env.DAREX_LOCAL_MAX_TOOL_CALLS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
})();

/**
 * Per-turn state shared by every model candidate that attempts the turn.
 * `sideEffects` records non-read tools that were dispatched; once non-empty,
 * the turn must not be replayed on another candidate or the HTTP path, or a
 * send/charge can run twice (RT-B03).
 */
export interface LocalTurnBudget {
  turnId: string;
  toolCalls: number;
  sideEffects: string[];
  controller?: AbortController;
  /** Results of read-only calls this turn, so an identical repeat reuses them. */
  readResults?: Map<string, unknown>;
}

export function readCallKey(tool: string, action: string, payload: unknown): string {
  return `${tool}\u0000${action}\u0000${JSON.stringify(payload ?? null)}`;
}

export function newLocalTurnBudget(): LocalTurnBudget {
  return { turnId: randomUUID(), toolCalls: 0, sideEffects: [] };
}

/**
 * Multi-tenant in-process ToolSet implementation for TrueForge AgentThread.
 * Bound to an orgId and optional userId at construction time.
 */
export class DarexLocalToolSet implements IToolSet {
  readonly name = 'darex';
  readonly id = 'darex';
  readonly description = 'Darex org-scoped business tools';
  readonly preload = true;
  readonly hasPreloadedTools = true;
  private readonly orgId: string;
  private readonly userId?: string;
  private readonly employeeRole?: string;
  private readonly toolAllowlist?: string[];
  private readonly availableTools: ToolDef[];
  private readonly budget: LocalTurnBudget;

  constructor(
    orgId: string,
    userId?: string,
    toolAllowlist?: string[],
    employeeRole?: string,
    userMessage?: string,
    budget: LocalTurnBudget = newLocalTurnBudget(),
  ) {
    this.budget = budget;
    this.orgId = orgId;
    this.userId = userId;
    this.employeeRole = employeeRole;
    this.toolAllowlist = toolAllowlist;
    // Strict intersection with the tenant/employee allowlist. Intent/role only
    // prioritize schema size — they never grant tools the org does not own.
    this.availableTools = selectToolsForLocalTurn(TOOLS, toolAllowlist, employeeRole, userMessage);
  }

  async listTools() {
    return {
      result: {
        tools: this.availableTools.map((t) => {
          const riskMeta = resolveToolRisk(t.tool, t.action);
          return {
            name: t.name,
            description: t.description,
            inputSchema: toolDefToJsonSchema(t),
            preload: true,
            annotations: {
              readOnlyHint: riskMeta?.risk === 'read',
              destructiveHint: riskMeta?.confirm === true || riskMeta?.risk === 'delete',
            },
          };
        }),
      },
      wasInitialized: undefined,
    };
  }

  async callTool(params: { name: string; arguments?: unknown }) {
    // Never fall back to the full TOOLS catalog — only tools exposed via the
    // allowlist-filtered availableTools set may execute in-process.
    const def = this.availableTools.find((t) => t.name === params.name);
    if (!def) {
      return toolResultResponse({
        text: JSON.stringify({
          status: 'error',
          message: `Tool "${params.name}" is not in this organisation's allowed tool list.`,
          allowed: false,
        }),
        isError: true,
      });
    }

    const parsed = parseToolArguments(def, params.arguments);
    if ('error' in parsed) {
      return toolResultResponse({
        text: JSON.stringify({ status: 'error', message: parsed.error }),
        isError: true,
      });
    }
    const invoked = resolveLocalToolInvocation(def, parsed.args);

    const riskMeta = resolveToolRisk(def.tool, invoked.action);
    const cacheKey = riskMeta?.risk === 'read' ? readCallKey(def.tool, invoked.action, invoked.payload) : null;
    const cached = cacheKey ? this.budget.readResults?.get(cacheKey) : undefined;
    if (cached) return cached as ReturnType<typeof toolResultResponse>;

    this.budget.toolCalls += 1;
    if (this.budget.toolCalls > LOCAL_TURN_MAX_TOOL_CALLS) {
      // A model that keeps calling after the cap gets a few refusals to wrap
      // up, then the turn is stopped.
      if (this.budget.toolCalls > LOCAL_TURN_MAX_TOOL_CALLS + 3) this.budget.controller?.abort();
      return toolResultResponse({
        text: JSON.stringify({
          status: 'error',
          message: `Tool-call limit for this turn (${LOCAL_TURN_MAX_TOOL_CALLS}) reached. Nothing was executed. Answer with the results you already have.`,
        }),
        isError: true,
      });
    }
    if (!riskMeta || riskMeta.risk !== 'read') this.budget.sideEffects.push(def.name);

    try {
      const result = await executeAutonomousToolAction({
        tool: def.tool,
        action: invoked.action,
        payload: invoked.payload,
        orgId: this.orgId,
        employeeRole: this.employeeRole,
        toolAllowlist: this.toolAllowlist,
      });

      let dataPayload = result.data;
      let text = JSON.stringify({
        status: result.status,
        message: result.message,
        data: dataPayload,
      });
      // Ensure the returned JSON is never corrupted by slicing mid-token.
      // If data is excessively large, truncate the data payload safely inside a valid JSON envelope.
      if (text.length > 20000) {
        if (typeof dataPayload === 'string') {
          dataPayload = dataPayload.slice(0, 15000) + '... [truncated]';
        } else if (Array.isArray(dataPayload)) {
          dataPayload = dataPayload.slice(0, 25);
        } else if (dataPayload && typeof dataPayload === 'object') {
          dataPayload = { ...dataPayload, _truncated: true };
        }
        text = JSON.stringify({
          status: result.status,
          message: result.message,
          data: dataPayload,
        });
      }

      const response = toolResultResponse({
        text: sanitizeToolOutput(text),
        isError: result.status === 'error',
      });
      if (cacheKey && result.status !== 'error') {
        (this.budget.readResults ??= new Map()).set(cacheKey, response);
      }
      return response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolResultResponse({
        text: JSON.stringify({ status: 'error', message: `Tool execution failed: ${msg}` }),
        isError: true,
      });
    }
  }

  async toolCallInfo(params: { name: string }) {
    const def = this.availableTools.find((t) => t.name === params.name);
    const riskMeta = def ? resolveToolRisk(def.tool, def.action) : null;
    const requireApproval = isToolApprovalRequired({
      toolName: params.name,
      toolDef: def,
      riskMeta,
    });
    return {
      type: 'mcp' as const,
      mcp_server_id: 'darex',
      mcp_server_name: 'darex',
      original_tool_name: params.name,
      is_approval_required: requireApproval,
    };
  }
}

function asText(content: unknown): string {
  return readModelText(content);
}

/**
 * Executes a turn via the in-process TrueForge AgentThread harness.
 */
async function executeLocalTurn(
  input: AgentTaskInput,
  modelCfg: LocalModelCandidate,
  opts?: RunAgentOptions,
  startTime: number = Date.now(),
  budget: LocalTurnBudget = newLocalTurnBudget(),
): Promise<AgentTurnResult> {
  let memory = opts?.retrievedMemory;
    if (!memory) {
      try {
        memory = await retrieveMemory({
          orgId: input.orgId,
          query: input.userMessage,
          employeeId: input.employeeId,
          conversationId: input.conversationId,
        });
      } catch {
        memory = emptyMemoryResult(input.orgId);
      }
    }
    const priorMsgs = opts?.priorMessages || (input as any).priorMessages;
    const groundedMessage = buildGroundedUserMessage(input, memory, priorMsgs);

    const modelClient = new VercelAILLM({
      providerConfig: {
        provider: { type: 'custom', name: 'darex-local' },
        model: { id: modelCfg.model, name: modelCfg.model },
        name: 'darex-local',
        baseUrl: modelCfg.baseUrl,
        apiKey: modelCfg.apiKey,
        headers: {},
      },
      logger: stubLogger(),
    });

    const systemInstruction = buildUnifiedSystemPrompt({
      orgId: input.orgId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      employeePersona: input.employeePersona,
    });

    const rootDefinition: AgentDefinition = {
      modelClient,
      instruction: systemInstruction,
      toolSets: [
        new DarexLocalToolSet(
          input.orgId,
          (input as { userId?: string }).userId,
          input.toolAllowlist,
          input.employeeRole,
          input.userMessage,
          budget,
        ),
      ],
    };

    const hasSandbox = true; // Local process fallback (python3/node/bash) or SANDBOX_API_URL
    const rootCapabilities = [
      currentDateTime({ tracing: noopTracing }),
      dynamicSubAgents({ tracing: noopTracing, sandboxAvailable: hasSandbox }),
      openUI({ preload: true }),
      contextCompaction({ definition: rootDefinition }),
      largeToolResponse({ dynamicSubAgentsPresent: true, logger: stubLogger() }),
    ];

    const sessionId = randomUUID();
    const rootThreadId = `darex-local:${input.orgId}:${sessionId}`;
    const rootThread = new AgentThread({
      definition: rootDefinition,
      threadId: rootThreadId,
      title: input.employeeName || 'darex-local-turn',
      capabilities: rootCapabilities,
      tracing: noopTracing,
      logger: stubLogger(),
    });

    const createDynamicSubAgentThread: CreateDynamicSubAgentThread = async (params) => {
      let childModelClient = modelClient;
      if (params.request.model && params.request.model !== modelCfg.model) {
        childModelClient = new VercelAILLM({
          providerConfig: {
            provider: { type: 'custom', name: 'darex-local' },
            model: { id: params.request.model, name: params.request.model },
            name: 'darex-local',
            baseUrl: modelCfg.baseUrl,
            apiKey: modelCfg.apiKey,
            headers: {},
          },
          logger: stubLogger(),
        });
      }

      const childDefinition: AgentDefinition = {
        ...params.parentDefinition,
        modelClient: childModelClient,
        // Inherit exact toolset bound to this orgId/userId for multi-tenant isolation
        toolSets: params.parentDefinition.toolSets,
        instruction: SUB_AGENT_IDENTITY,
        messages: [{ role: 'user', content: params.request.input }],
        responseFormat: undefined,
      };

      return new AgentThread({
        definition: childDefinition,
        threadId: params.threadId,
        title: params.request.name,
        parent: params.parent,
        agentInfo: params.request,
        capabilities: [
          currentDateTime({ tracing: noopTracing }),
          contextCompaction({ definition: childDefinition }),
          largeToolResponse({ dynamicSubAgentsPresent: false, logger: stubLogger() }),
        ],
        tracing: noopTracing,
        logger: stubLogger(),
      });
    };

    const orchestrator = new AgentThreadOrchestrator({
      agentThreads: new Map([[rootThreadId, rootThread]]),
      createDynamicSubAgentThread,
      tracing: noopTracing,
      logger: stubLogger(),
    });

    const controller = new AbortController();
    budget.controller = controller;
    const timeoutMs = opts?.timeoutMs || 120_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const unbindAbort = bindExternalAbort(controller, opts?.signal);

    let reply = '';
    const tools: AgentToolStep[] = [];
    const approvals: ApprovalRequest[] = [];
    const subagents: SubagentEvent[] = [];
    const subagentStartTimes = new Map<string, { startTime: number; name: string; title: string; input: string; model?: string }>();
    const callIdToName = new Map<string, string>();
    const pendingNames: string[] = [];
    const resolveToolName = (ev: Record<string, unknown>): string => {
      const callId = typeof ev.tool_call_id === 'string' ? ev.tool_call_id : '';
      if (callId && callIdToName.has(callId)) return callIdToName.get(callId) as string;
      if (typeof ev.tool_name === 'string' && ev.tool_name !== 'tool') return ev.tool_name;
      const last = pendingNames.pop();
      return last || 'tool';
    };

    try {
      for await (const _sent of orchestrator.send([{ type: 'user.message', content: groundedMessage }])) {
        // send() yields context-append acks; results arrive via execute().
      }
      for await (const event of orchestrator.execute({ signal: controller.signal })) {
        const ev = event as unknown as Record<string, unknown>;
        const type = typeof ev.type === 'string' ? ev.type : '';
        const threadId = typeof ev.thread_id === 'string' ? ev.thread_id : '';
        const isRoot = !threadId || threadId === rootThreadId;

        if (type === EventType.THREAD_CREATED && ev.agent_info) {
          const info = ev.agent_info as { name?: string; input?: string; model?: string };
          const name = String(info.name || ev.title || 'subagent');
          const instruction = String(info.input || '');
          const subThreadId = String(ev.thread_id || `sub-${Date.now()}`);
          subagentStartTimes.set(subThreadId, {
            startTime: Date.now(),
            name,
            title: String(ev.title || name),
            input: instruction,
            model: info.model,
          });
          const startEv: SubagentEvent = {
            threadId: subThreadId,
            title: String(ev.title || name),
            name,
            instruction,
            model: info.model,
            status: 'started',
            createdAt: String(ev.created_at || new Date().toISOString()),
          };
          subagents.push(startEv);
          opts?.onSubagent?.(startEv);
          tools.push({ tool: 'subagent_start', argsLabel: name, threadId: subThreadId });
          opts?.onToolProgress?.('subagent_start', `Started subagent: ${name}`);
        } else if (type === EventType.THREAD_DONE) {
          const subThreadId = String(ev.thread_id || '');
          const meta = subagentStartTimes.get(subThreadId);
          const durationMs = meta ? Date.now() - meta.startTime : undefined;
          const doneEv: SubagentEvent = {
            threadId: subThreadId,
            title: String(ev.title || meta?.title || 'subagent'),
            name: String(meta?.name || ev.title || 'subagent'),
            instruction: meta?.input || '',
            model: meta?.model,
            status: 'done',
            durationMs,
            createdAt: String(ev.created_at || new Date().toISOString()),
          };
          subagents.push(doneEv);
          opts?.onSubagent?.(doneEv);
          tools.push({ tool: 'subagent_done', argsLabel: subThreadId, result: subThreadId, threadId: subThreadId });
          opts?.onToolProgress?.('subagent_done', `Completed subagent execution`);
        } else if (type === EventType.MODEL_MESSAGE_DELTA && typeof ev.content === 'string') {
          if (isRoot) {
            reply += ev.content;
            opts?.onChunk?.(ev.content);
          }
        }
        if (type === EventType.MODEL_MESSAGE_DELTA && Array.isArray(ev.tool_calls)) {
          for (const tc of ev.tool_calls as Array<Record<string, unknown>>) {
            const fn = tc.function as Record<string, unknown> | undefined;
            const name = typeof fn?.name === 'string' && fn.name ? fn.name : null;
            const callId = typeof tc.id === 'string' ? tc.id : '';
            if (name) {
              if (callId) callIdToName.set(callId, name);
              pendingNames.push(name);
              opts?.onToolProgress?.(name, labelText(fn?.arguments).slice(0, 100));
            }
          }
        } else if (type === EventType.TOOL_RESPONSE) {
          const toolName = resolveToolName(ev);
          let full = asText((ev as { content?: unknown }).content);
          if (!full && (ev as { error?: unknown }).error) {
            full = asText((ev as { error?: unknown }).error);
          }
          let progressLabel = full.slice(0, 100);
          try {
            const parsed = JSON.parse(full);
            if (parsed.message) progressLabel = labelText(parsed.message).slice(0, 100);
            else if (parsed.output) progressLabel = labelText(parsed.output).slice(0, 100);
          } catch {}
          const step: AgentToolStep = {
            tool: toolName,
            argsLabel: progressLabel,
            ...(isRoot ? {} : { threadId }),
          };
          if (full) step.result = full.slice(0, 4000);
          const pending = [...tools].reverse().find((t) => t.tool === toolName && !t.result && (isRoot ? !t.threadId : t.threadId === threadId || !t.threadId));
          if (pending && full) {
            pending.result = full.slice(0, 4000);
            if (!isRoot && threadId && !pending.threadId) pending.threadId = threadId;
          } else tools.push(step);
          opts?.onToolProgress?.(toolName, progressLabel);
        } else if (type === EventType.TOOL_APPROVAL_REQUIRED || type === EventType.TOOL_RESPONSE_REQUIRED) {
          const refs = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
          for (const ref of refs) {
            const callId = typeof (ref as any)?.id === 'string' ? (ref as any).id : '';
            const name = (callId && callIdToName.get(callId)) || 'tool';
            if (callId) {
              approvals.push({ threadId: threadId || rootThreadId, toolCallId: callId, toolName: name });
            }
            const label = `${name} needs approval`;
            tools.push({ tool: 'approval_required', argsLabel: label });
            opts?.onToolProgress?.('approval_required', label);
          }
          if (refs.length === 0) {
            tools.push({ tool: 'approval_required', argsLabel: 'approval paused the turn' });
            opts?.onToolProgress?.('approval_required', 'approval paused the turn');
          }
        } else if (type === 'internal.agent.done' && isRoot) {
          if (ev.status === 'error') {
            throw new Error(`Local turn error: ${String(ev.error || 'unknown')}`);
          }
          const output = ev.output as { content?: unknown } | undefined;
          if (!reply && output) {
            reply = asText(output.content);
            if (reply) opts?.onChunk?.(reply);
          }
        }
        if (controller.signal.aborted) break;
      }
    } finally {
      clearTimeout(timer);
      unbindAbort();
    }

    const threadMetrics = rootThread.getAgentThreadMetrics();
    const durationMs = Math.max(0, Date.now() - startTime);
    const totalTokens = threadMetrics.total_tokens || ((threadMetrics.total_input_tokens ?? 0) + (threadMetrics.total_output_tokens ?? 0));
    const cachedTokens = (threadMetrics.total_cache_read_tokens ?? 0) + (threadMetrics.total_cache_write_tokens ?? 0);
    const usage: TurnUsage = {
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      inputTokens: threadMetrics.total_input_tokens,
      outputTokens: threadMetrics.total_output_tokens,
      cachedTokens: cachedTokens > 0 ? cachedTokens : undefined,
      totalCostInUsd: threadMetrics.total_cost_in_usd,
      durationMs,
    };

    if (approvals.length > 0) {
      putLocalSession(sessionId, {
        sessionId,
        orchestrator,
        rootThreadId,
        rootThread,
        input,
        tools,
        subagents,
        callIdToName,
        createdAt: Date.now(),
      });
    }

    return {
      reply: reply.trim(),
      sessionId,
      model: `inprocess/${modelCfg.model}`,
      tools,
      approvals,
      subagents,
      usage,
    };
}

/**
 * Executes a turn via the in-process TrueForge AgentThread harness with automatic
 * candidate model failover across Gemini, Groq, OpenRouter, and LiteLLM.
 */
export async function runLocalTurn(
  input: AgentTaskInput,
  opts?: RunAgentOptions,
): Promise<AgentTurnResult | null> {
  if (!inprocessTurnsEnabled()) return null;
  const candidates = getLocalModelCandidates();
  if (candidates.length === 0 || !candidates.some((c) => Boolean(c.apiKey))) {
    console.warn('[local-turn] no model key configured — falling back to HTTP path');
    return null;
  }

  const startTime = Date.now();
  let lastError: unknown = null;
  const budget = newLocalTurnBudget();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate.apiKey) continue;
    if (!isProviderAvailable(candidate.name)) {
      console.warn(`[local-turn] skipping open circuit for provider "${candidate.name}"`);
      continue;
    }
    try {
      const result = await executeLocalTurn(input, candidate, opts, startTime, budget);
      recordProviderSuccess(candidate.name);
      return result;
    } catch (err: unknown) {
      lastError = err;
      recordProviderFailure(candidate.name);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[local-turn] candidate "${candidate.name}" (${candidate.model}) failed: ${msg}`);
      if (budget.sideEffects.length > 0) {
        // Tools with side effects already ran. Replaying the turn on another
        // candidate — or letting the caller fall through to the HTTP path —
        // could send or charge twice. Stop and report what ran.
        return sideEffectStopResult(budget, candidate, startTime);
      }
      if (i < candidates.length - 1) {
        console.info(`[local-turn] attempting next candidate "${candidates[i + 1].name}"...`);
      }
    }
  }

  console.warn('[local-turn] all local model candidates failed, falling back to HTTP path:', lastError instanceof Error ? lastError.message : lastError);
  return null;
}

/**
 * Result for a turn that failed after a non-read tool was dispatched. It is
 * non-empty (tools listed) so `runTrueForgeTurn` returns it instead of
 * re-running the turn on the HTTP path.
 */
export function sideEffectStopResult(
  budget: LocalTurnBudget,
  candidate: Pick<LocalModelCandidate, 'model'>,
  startTime: number,
): AgentTurnResult {
  const names = [...new Set(budget.sideEffects)];
  return {
    reply:
      `The model failed partway through this request after calling ${names.join(', ')}. ` +
      'I did not retry, so nothing runs twice. Check the tool results before asking again.',
    sessionId: budget.turnId,
    model: `inprocess/${candidate.model}`,
    tools: names.map((name) => ({ tool: name, argsLabel: 'dispatched before the model failed; not retried' })),
    approvals: [],
    subagents: [],
    usage: { durationMs: Math.max(0, Date.now() - startTime) },
  };
}

/**
 * Resumes an in-process turn paused on tool approvals or user questions.
 */
export async function resumeLocalTurn(
  input: ResumeTurnInput,
  opts?: RunAgentOptions,
): Promise<AgentTurnResult | null> {
  const active = activeLocalOrchestrators.get(input.sessionId);
  if (!active) return null;
  if (active.input.orgId !== input.orgId) {
    console.warn(`[local-turn] Tenant mismatch on session resume: expected ${active.input.orgId}, got ${input.orgId}`);
    return null;
  }

  const { orchestrator, rootThreadId, rootThread, callIdToName } = active;
  const tools = [...active.tools];
  const approvals: ApprovalRequest[] = [];
  const subagents = [...active.subagents];
  let reply = '';
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs || 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unbindAbort = bindExternalAbort(controller, opts?.signal);

  const resolveToolName = (ev: Record<string, unknown>): string => {
    const callId = typeof ev.tool_call_id === 'string' ? ev.tool_call_id : '';
    if (callId && callIdToName.has(callId)) return callIdToName.get(callId) as string;
    if (typeof ev.tool_name === 'string' && ev.tool_name !== 'tool') return ev.tool_name;
    return 'tool';
  };

  try {
    const sendBatch = input.decisions.map((d) => ({
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: d.threadId,
      tool_call_id: d.toolCallId,
      approval: d.decision === 'allow'
        ? { status: 'allow' as const }
        : { status: 'deny' as const, reason: d.reason || 'Denied by user' },
    }));

    for await (const _ of orchestrator.send(sendBatch as any)) {
      // acknowledged context append
    }

    for await (const event of orchestrator.execute({ signal: controller.signal })) {
      const ev = event as unknown as Record<string, unknown>;
      const type = typeof ev.type === 'string' ? ev.type : '';
      const threadId = typeof ev.thread_id === 'string' ? ev.thread_id : '';
      const isRoot = !threadId || threadId === rootThreadId;

      if (type === EventType.MODEL_MESSAGE_DELTA && typeof ev.content === 'string') {
        if (isRoot) {
          reply += ev.content;
          opts?.onChunk?.(ev.content);
        }
      } else if (type === EventType.TOOL_RESPONSE) {
        const toolName = resolveToolName(ev);
        const full = asText((ev as { content?: unknown }).content);
        const step: AgentToolStep = { tool: toolName, argsLabel: full.slice(0, 100) };
        if (full) step.result = full.slice(0, 4000);
        tools.push(step);
        opts?.onToolProgress?.(toolName, full.slice(0, 100));
      } else if (type === EventType.TOOL_APPROVAL_REQUIRED || type === EventType.TOOL_RESPONSE_REQUIRED) {
        const refs = Array.isArray(ev.tool_calls) ? ev.tool_calls : [];
        for (const ref of refs) {
          const callId = typeof (ref as any)?.id === 'string' ? (ref as any).id : '';
          const name = (callId && callIdToName.get(callId)) || 'tool';
          if (callId) approvals.push({ threadId: threadId || rootThreadId, toolCallId: callId, toolName: name });
        }
      } else if (type === 'internal.agent.done' && isRoot) {
        const output = ev.output as { content?: unknown } | undefined;
        if (!reply && output) {
          reply = asText(output.content);
          if (reply) opts?.onChunk?.(reply);
        }
      }
      if (controller.signal.aborted) break;
    }
  } finally {
    clearTimeout(timer);
    unbindAbort();
    if (approvals.length === 0) {
      activeLocalOrchestrators.delete(input.sessionId);
    }
  }

  const threadMetrics = rootThread.getAgentThreadMetrics();
  const usage: TurnUsage = {
    totalTokens: threadMetrics.total_tokens || ((threadMetrics.total_input_tokens ?? 0) + (threadMetrics.total_output_tokens ?? 0)),
    inputTokens: threadMetrics.total_input_tokens,
    outputTokens: threadMetrics.total_output_tokens,
    totalCostInUsd: threadMetrics.total_cost_in_usd,
    durationMs: Date.now() - startTime,
  };

  return {
    reply: reply.trim(),
    sessionId: input.sessionId,
    model: active.rootThread.definition.modelClient.toString?.() || 'inprocess',
    tools,
    approvals,
    subagents,
    usage,
  };
}
