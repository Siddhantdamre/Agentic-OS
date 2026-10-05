import { NextResponse } from 'next/server';
import { getOrgScopedClient, getScopedClient, releaseScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { recordAuditEvent } from '@/lib/audit-events';
import { classifyRequest } from '@/lib/classify';
import { generatePlan } from '@/lib/plan-generator';
import { getPlaybook, playbookToPlan } from '@/lib/playbook-matcher';
import {
  loadOrgPromotedPlaybooks,
  matchOrgPromotedPlaybook,
  orgPlaybookToPlan,
} from '@/lib/insight-engine';
import {
  denyAskAiBusy,
  denyAskAiIfLimitedAsync,
  isRateLimitError,
  responseFromRateLimit,
  tryAcquireConcurrency,
} from '@/lib/rate-limit';
import { assertUsageAllowed } from '@/lib/usage-gate';
import {
  runAutonomousAgentDirect,
  sanitizeAgentReply,
} from '@darex/workflows/dist/agent-client';
import { retrieveMemory } from '@darex/workflows/dist/memory/retrieve';
import { planRequiresDurableExecute } from '@darex/workflows/dist/plan-steps';
import { turnSpendCents } from '@darex/workflows/dist/cost/budget';
import { startCrewWorkflow, startMemoryWriteBackWorkflow, startPlanExecuteWorkflow } from '@darex/workflows/dist/workflow-client';
import { insertAskAiMessage, persistAskAiMessage } from '@/lib/ask-ai-persist';
import {
  allowlistForEmployeeTurn,
  allowlistForLockedEmployeeTurn,
  allowlistPlainPublic,
  personaPlain,
  routeAskEmployee,
  type AskEmployee,
} from '@/lib/ask-employee';
import {
  filterValidEmployeeRows,
  heuristicCrewPlan,
  isActiveCrewMember,
  resolveCrewAssignments,
} from '@/lib/crew-planner';
import { awaitCrewHandleWithAbort } from '@/lib/crew-abort';
import {
  fixedTeamCrewPlan,
  isAskMode,
  parseAskModeBody,
  resolveAskMode,
  autoPlanEmployee,
  stampPlanStepsForMode,
  withAutoRoutingReason,
  type AskMode,
  type AskRouting,
  type OrgEmployeeRow,
} from '@/lib/ask-mode';
import type { AgentTaskInput, CrewPlan, CrewRosterMember, CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import { runCrewDirect } from '@darex/workflows/dist/crew-runner';
import type { PoolClient } from 'pg';
import { resolveLockedHandoff, resolveCustomHandoff, type HandoffOffer } from '@/lib/handoffs';
import { readJsonBody } from '@/lib/safe-json';
import { askAiPromptTooLong } from '@/lib/ask-ai-limits';
import { publicErrorMessage } from '@/lib/public-error';

export const dynamic = 'force-dynamic';

const ASK_AI_CONTACT_PREFIX = 'ask-ai:';

function dailySessionKey(orgId: string, userId: string): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `askai-${orgId}-${userId}-${day}`;
}

function buildPersona(
  orgName: string,
  currentUserEmail: string,
  connectedChannels: string[],
  orgId: string,
  employee?: AskEmployee | null,
): string {
  const connected =
    connectedChannels.length > 0
      ? connectedChannels.join(', ')
      : 'none — do not invent connector data; tell the user to connect tools at /connectors';
  const ownTools = employee?.tools?.length ? employee.tools.join(', ') : 'the org tool union';
  const identity = employee
    ? `You are ${employee.name}, ${employee.role}, an AI employee for ${orgName}. Your job: ${employee.persona || employee.role}. Your authorized tools: ${ownTools}. Current user: ${currentUserEmail}. Use these tools to do the work. If a connector is not signed in, say that plainly and link the connect path from that tool result (it looks like /connectors?connect=gmail), then finish the rest of the request with the tools that are signed in. Do not stop the turn on that one tool. Do not invent that connector's data. Stay in this role.`
    : `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. If a connector is not signed in, say that plainly and link the connect path from that tool result (it looks like /connectors?connect=gmail), then finish the rest of the request with the tools that are signed in. Do not invent that connector's data.`;
  return `${identity} Connected connectors: ${connected}. Core tools always available: database_query, web_search, web_extract, file_ops, google_slides, google_docs, google_sheets, terminal_run_command, python_execute, code_execution, gmail, slack, hubspot, stripe. Act decisively and execute tools when needed.
Executive Quality Standard & User Taste Alignment:
- The user expects elite, executive-level work across EVERY tool and domain. Understand and mirror the user's taste: deep, rigorous, substantive, and meticulously structured.
- Substance Over Fluff: NEVER output shallow 1-line bullet points or generic filler platitudes (like "improves efficiency" or "streamlines workflows"). Always provide concrete mechanisms, architecture breakdowns, exact KPIs, percentages, dollar figures, and strategic implications.
- Visual Canvas Hygiene: Tools that render visually (Google Slides, Google Docs, Google Sheets) render text natively. NEVER dump raw markdown asterisks (**bold**), hashtag headers (##), or raw markdown table borders into tool arguments. Supply clean, polished text with structured titles and bodies.
- Tool-by-Tool Delivery Standards:
  * Terminal & Python Hands ('terminal_run_command', 'python_execute', 'code_execution'): You have full terminal and code execution hands! Execute shell commands (bash, curl, jq, bc, text processing) and run Python 3 scripts in the isolated sandbox. Use your terminal hands whenever you need exact calculations, complex data transformations, file formatting, algorithmic processing, or verification.
  * Google Slides: 10-15 high-density slides covering taxonomy, architecture, tools, enterprise case studies, and ROI metrics. Pass clean titles and rich bullet arrays directly into 'slides_create' or 'slides_update_slide'. Always verify with 'slides_get'.
  * Google Docs: Generate full structured documents (Executive Summary, Technical Architecture, Operational Framework, Quantitative Analysis, Roadmap). Pass clean formatted content into 'docs_create' or 'docs_append'. Always verify with 'docs_read'.
  * Google Sheets: Build complete financial and operational models. Provide clear headers, typed numerical values (currencies, percentages, integers), and summary/total calculations. Pass rows/tables to 'sheets_create' or 'sheets_append_row'. Always verify with 'sheets_read'.
  * Database & SQL ('database_query'): Execute single-statement queries safely. Format all query results into clean Markdown tables with aligned columns. ALWAYS accompany data with an 'Executive Analysis' identifying trends, anomalies, outliers, and business decisions.
  * Web Research ('web_search', 'web_extract'): Perform deep, multi-source research. Synthesize quantitative benchmarks, dates, market landscape comparisons, and clickable citation links.
  * Communications (Gmail, Slack, WhatsApp): Deliver executive polish—crisp subject lines, concise context, numbered action items with owners and deadlines, and professional sign-offs.
  * CRM & Revenue (HubSpot, Stripe, Zendesk): Track ARR, MRR, customer LTV, churn risks, and SLA resolution metrics with exact numbers.
End-to-End Task Execution: Complete the entire task requested end-to-end in this turn without stopping halfway. NEVER stall by asking unnecessary permission (e.g. NEVER ask "Would you like me to proceed?"). Take full ownership and deliver the completed result directly.
Self-Verification & Quality Assurance: Never stop at just executing an action and assuming it is done or correct. You must verify your work and check its quality before finishing. Read back created resources (slides_get, docs_read, sheets_read, database queries) and self-correct any flaws immediately. In your final response, include a brief 'Verification & Deliverables Summary' with direct clickable Markdown links to all created artifacts.
You maintain full conversational continuity: ALWAYS recall and reference names, codes, topics, and requests mentioned in prior messages in this conversation.`;
}

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    return await fn(client);
  } finally {
    await releaseScopedClient(client);
  }
}

async function ensureAskAiConversation(
  client: PoolClient,
  orgId: string,
  userId: string
): Promise<{ id: string; summary: string }> {
  const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
  const existing = await client.query(
    `SELECT id, summary FROM conversations
     WHERE org_id = $1 AND contact_id = $2 AND metadata->>'source' = 'ask-ai'
     ORDER BY updated_at DESC LIMIT 1`,
    [orgId, contactId]
  );
  if (existing.rows[0]?.id) {
    return {
      id: existing.rows[0].id,
      summary: existing.rows[0].summary || 'Ask AI',
    };
  }

  const created = await client.query(
    `INSERT INTO conversations (org_id, contact_id, status, summary, metadata, started_at, updated_at)
     VALUES ($1, $2, 'open', 'Ask AI', $3::jsonb, NOW(), NOW())
     RETURNING id, summary`,
    [orgId, contactId, JSON.stringify({ source: 'ask-ai', userId })]
  );
  return {
    id: created.rows[0].id,
    summary: created.rows[0].summary || 'Ask AI',
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOwnedAskAiConversation(
  client: PoolClient,
  orgId: string,
  userId: string,
  conversationId: string
): Promise<string | null> {
  const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
  const found = await client.query(
    `SELECT id FROM conversations
     WHERE id = $1 AND org_id = $2
       AND (
         contact_id = $3
         OR (metadata->>'source' = 'ask-ai' AND metadata->>'userId' = $4)
       )
     LIMIT 1`,
    [conversationId, orgId, contactId, userId]
  );
  return found.rows[0]?.id ? String(found.rows[0].id) : null;
}

async function resolveConversationId(
  client: PoolClient,
  orgId: string,
  userId: string,
  requestedId?: string
): Promise<string> {
  if (requestedId) {
    const owned = await findOwnedAskAiConversation(client, orgId, userId, requestedId);
    if (owned) return owned;
    // Never attach to another user's thread. Only mint a client-supplied UUID
    // when it does not already exist (any owner) in this org.
    if (UUID_RE.test(requestedId)) {
      const anyOwner = await client.query(
        `SELECT id FROM conversations WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [requestedId, orgId]
      );
      if (anyOwner.rows[0]?.id) {
        const ensured = await ensureAskAiConversation(client, orgId, userId);
        return ensured.id;
      }
      const created = await client.query(
        `INSERT INTO conversations (id, org_id, contact_id, status, summary, metadata, started_at, updated_at)
         VALUES ($1, $2, $3, 'open', 'Ask AI', $4::jsonb, NOW(), NOW())
         RETURNING id`,
        [requestedId, orgId, `${ASK_AI_CONTACT_PREFIX}${userId}`, JSON.stringify({ source: 'ask-ai', userId })]
      );
      return created.rows[0].id;
    }
  }
  const ensured = await ensureAskAiConversation(client, orgId, userId);
  return ensured.id;
}

async function loadConversationAskMode(
  client: PoolClient,
  conversationId: string,
): Promise<{ mode: AskMode; employeeIds: string[]; unset: boolean }> {
  try {
    const res = await client.query(
      `SELECT ask_mode, ask_employee_ids FROM conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
    );
    const row = res.rows[0];
    if (!row) return { mode: 'auto', employeeIds: [], unset: true };
    const mode: AskMode = isAskMode(row.ask_mode) ? row.ask_mode : 'auto';
    const employeeIds = Array.isArray(row.ask_employee_ids)
      ? row.ask_employee_ids.map((id: unknown) => String(id))
      : [];
    const unset = mode === 'auto' && employeeIds.length === 0;
    return { mode, employeeIds, unset };
  } catch (err: unknown) {
    // Migration 107 not applied yet — treat as unset auto.
    if ((err as { code?: string })?.code === '42703') {
      return { mode: 'auto', employeeIds: [], unset: true };
    }
    throw err;
  }
}

async function loadUserAskModePrefs(
  client: PoolClient,
  orgId: string,
  userId: string,
): Promise<{ mode: AskMode; employeeIds: string[] }> {
  try {
    const res = await client.query(
      `SELECT ask_mode, ask_employee_ids FROM ask_ai_user_mode_prefs
        WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
      [orgId, userId],
    );
    const row = res.rows[0];
    if (!row) return { mode: 'auto', employeeIds: [] };
    return {
      mode: isAskMode(row.ask_mode) ? row.ask_mode : 'auto',
      employeeIds: Array.isArray(row.ask_employee_ids)
        ? row.ask_employee_ids.map((id: unknown) => String(id))
        : [],
    };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703') {
      return { mode: 'auto', employeeIds: [] };
    }
    throw err;
  }
}

async function persistAskModeChoice(
  client: PoolClient,
  orgId: string,
  userId: string,
  conversationId: string,
  mode: AskMode,
  employeeIds: string[],
): Promise<void> {
  try {
    const prior = await client.query<{ ask_mode: string | null; ask_employee_ids: string[] | null }>(
      `SELECT ask_mode, ask_employee_ids FROM conversations WHERE id = $1 AND org_id = $2`,
      [conversationId, orgId],
    );
    await client.query(
      `UPDATE conversations
          SET ask_mode = $1, ask_employee_ids = $2::uuid[], updated_at = NOW()
        WHERE id = $3 AND org_id = $4`,
      [mode, employeeIds, conversationId, orgId],
    );
    await client.query(
      `INSERT INTO ask_ai_user_mode_prefs (org_id, user_id, ask_mode, ask_employee_ids, updated_at)
       VALUES ($1, $2, $3, $4::uuid[], NOW())
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET ask_mode = EXCLUDED.ask_mode,
             ask_employee_ids = EXCLUDED.ask_employee_ids,
             updated_at = NOW()`,
      [orgId, userId, mode, employeeIds],
    );
    // Saved on every turn; audit only an actual change of who answers (ASK-E01).
    const before = prior.rows[0];
    const sameIds = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
    if (before && (before.ask_mode !== mode || !sameIds(before.ask_employee_ids ?? [], employeeIds))) {
      try {
        await recordAuditEvent(
          {
            orgId,
            kind: 'settings.update',
            actor: { actorType: 'user', userId },
            resultStatus: 'ok',
            payload: {
              setting: 'ask_ai.mode',
              conversationId,
              from: { mode: before.ask_mode, employeeIds: before.ask_employee_ids ?? [] },
              to: { mode, employeeIds },
            },
          },
          { client, orgId },
        );
      } catch (auditErr: unknown) {
        console.warn('[Ask AI] mode change audit failed:', auditErr instanceof Error ? auditErr.message : auditErr);
      }
    }
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '42703' || code === '42P01') {
      console.warn('[Ask AI] ask mode columns/table missing — skip persist (run migration 107)');
      return;
    }
    throw err;
  }
}

function askEmployeeFromRow(row: OrgEmployeeRow, reason: string): AskEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role || '',
    persona: personaPlain(row.persona),
    tools: allowlistPlainPublic(row.tool_allowlist),
    reason,
  };
}



async function client2InsertPlan(
  client: PoolClient,
  planId: string,
  orgId: string,
  userId: string,
  conversationId: string,
  generated: {
    reasoning: string;
    summary: string;
    steps: any[];
    draft: string;
  },
  classification: { confidence: number; usedFallback: boolean }
): Promise<void> {
  await client.query(
    `INSERT INTO agent_plans (id, org_id, user_id, thread_id, summary, steps, status, current_step, draft, reasoning, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $8, NOW(), NOW())`,
    [
      planId,
      orgId,
      userId,
      conversationId || 'ask-ai',
      generated.summary || 'Multi-step agent plan',
      JSON.stringify(generated.steps),
      generated.draft ? JSON.stringify({ content: generated.draft, version: 1 }) : null,
      JSON.stringify({
        text: generated.reasoning,
        durationMs: null,
        confidence: classification.confidence,
        usedFallback: classification.usedFallback,
      }),
    ]
  );
}

export async function POST(request: Request) {
  let client: PoolClient | null = null;

  // Acquire + release the pooled connection around ONLY the short-lived DB
  // reads. Releasing before opening the SSE stream prevents the pool
  // (max:10) from being starved by long-running Ask AI streams.
  const release = () => {
    if (client) {
      client.release();
      client = null;
    }
  };

  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const orgId = scoped.orgId;
    const userId = scoped.userId;

    const usageBlock = await assertUsageAllowed(orgId);
    if (usageBlock) {
      release();
      return NextResponse.json(
        {
          error: usageBlock.error,
          message: usageBlock.message,
          reasons: usageBlock.gate.reasons,
        },
        { status: 402 }
      );
    }

    const limited = await denyAskAiIfLimitedAsync(orgId, userId);
    if (limited) {
      release();
      return limited;
    }
    let orgName = 'Your Business';
    let currentUserEmail = 'user@company.com';
    let connectedChannelsList: string[] = [];

    try {
      const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
      orgName = orgRes.rows[0]?.name || 'Your Business';

      const userRes = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userRes.rows[0]?.email) currentUserEmail = userRes.rows[0].email;

      const chanRes = await client.query(
        "SELECT channel_type FROM channels WHERE org_id = $1 AND (status = 'active' OR status = 'connected')",
        [orgId]
      );
      connectedChannelsList = chanRes.rows.map((r: any) => r.channel_type);

    } catch (ctxErr: unknown) {
      console.warn(
        '[Ask AI] Failed to load org/user/channel context:',
        ctxErr instanceof Error ? ctxErr.message : ctxErr
      );
    }

    const parsedBody = await readJsonBody(request);
    if (!parsedBody.ok) {
      release();
      return parsedBody.response;
    }
    const body: Record<string, unknown> | null = parsedBody.body;
    if (body?.org_id !== undefined || body?.orgId !== undefined) {
      release();
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }
    const prompt = (body as Record<string, unknown>)?.prompt;
    const requestedConversationId =
      typeof body?.conversationId === 'string' ? body.conversationId : undefined;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      release();
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }
    const promptTooLong = askAiPromptTooLong(prompt);
    if (promptTooLong) {
      release();
      return NextResponse.json({ error: promptTooLong }, { status: 413 });
    }

    let conversationId = requestedConversationId || '';
    let priorMessages: Array<{ role: string; content: string }> = [];
    let contextLoadFailed = false;
    let conversationAsk = { mode: 'auto' as AskMode, employeeIds: [] as string[], unset: true };
    let userAskPrefs = { mode: 'auto' as AskMode, employeeIds: [] as string[] };
    try {
      conversationId = await resolveConversationId(client, orgId, userId, requestedConversationId);
      conversationAsk = await loadConversationAskMode(client, conversationId);
      userAskPrefs = await loadUserAskModePrefs(client, orgId, userId);
      // Cap history length and per-message size to keep prompt tokens bounded.
      const histRes = await client.query(
        `SELECT role, content FROM (
           SELECT role, content, created_at FROM messages
           WHERE org_id = $1 AND conversation_id = $2
           ORDER BY created_at DESC
           LIMIT 12
         ) sub ORDER BY created_at ASC`,
        [orgId, conversationId]
      );
      priorMessages = histRes.rows.map((r) => ({
        role: String(r.role),
        content: String(r.content || '').slice(0, 2000),
      }));
      await insertAskAiMessage(client, orgId, conversationId, 'user', String(prompt));
    } catch (persistErr: any) {
      contextLoadFailed = true;
      priorMessages = [];
      console.warn('[Ask AI] Failed to persist user message:', persistErr?.message);
    }

    let employeeRows: Array<{
      id?: string;
      name?: string;
      role?: string;
      persona?: unknown;
      tool_allowlist?: unknown;
      status?: string;
      archived_at?: string | null;
    }> = [];
    try {
      const empRes = await client.query(
        `SELECT id, name, role, persona, tool_allowlist, status, archived_at
           FROM ai_employees
          WHERE org_id = $1 AND archived_at IS NULL
          ORDER BY created_at ASC`,
        [orgId],
      );
      employeeRows = empRes.rows;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '42703' && client) {
        try {
          const empRes = await client.query(
            `SELECT id, name, role, persona, tool_allowlist, status
               FROM ai_employees WHERE org_id = $1 ORDER BY created_at ASC`,
            [orgId],
          );
          employeeRows = empRes.rows;
        } catch (fallbackErr: unknown) {
          console.warn(
            '[Ask AI] ai_employees fallback query failed:',
            fallbackErr instanceof Error ? fallbackErr.message : fallbackErr
          );
        }
      } else {
        console.warn(
          '[Ask AI] Failed to load ai_employees:',
          err instanceof Error ? err.message : err
        );
      }
    }

    const orgEmployeeRows: OrgEmployeeRow[] = employeeRows
      .filter((row) => row.id && row.name)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        role: String(row.role || ''),
        persona: row.persona,
        tool_allowlist: row.tool_allowlist,
        status: row.status,
        archived_at: row.archived_at ?? null,
      }));

    const parsedMode = parseAskModeBody(body);
    if (parsedMode.parseError) {
      release();
      return NextResponse.json({ error: parsedMode.parseError }, { status: 400 });
    }

    const promptStr = String(prompt).trim();
    const modeResolved = resolveAskMode({
      bodyMode: parsedMode.mode,
      bodyEmployeeIds: parsedMode.employeeIds,
      conversationMode: conversationAsk.mode,
      conversationEmployeeIds: conversationAsk.employeeIds,
      lastChoiceMode: userAskPrefs.mode,
      lastChoiceEmployeeIds: userAskPrefs.employeeIds,
      conversationIsUnset: conversationAsk.unset,
      orgEmployees: orgEmployeeRows,
      messageText: promptStr,
    });
    if (!modeResolved.ok) {
      release();
      return NextResponse.json({ error: modeResolved.error }, { status: modeResolved.status });
    }
    const askSelection = modeResolved.selection;

    if (conversationId && !contextLoadFailed) {
      try {
        await persistAskModeChoice(
          client,
          orgId,
          userId,
          conversationId,
          askSelection.persistMode,
          askSelection.persistEmployeeIds,
        );
      } catch (persistModeErr: unknown) {
        console.warn(
          '[Ask AI] Failed to persist ask mode:',
          persistModeErr instanceof Error ? persistModeErr.message : persistModeErr,
        );
      }
    }

    // Release before classify / plan / agent — those are slow and must not hold a pool slot.
    release();

    const orgTools = employeeRows.flatMap((row) => allowlistPlainPublic(row.tool_allowlist));
    let askEmployee: AskEmployee | null = null;
    let turnTools: string[] = [];
    let routing: AskRouting = askSelection.routing;

    switch (askSelection.turnMode) {
      case 'single': {
        const locked = askSelection.turnEmployees[0];
        if (locked) {
          askEmployee = askEmployeeFromRow(locked, routing.reason);
          turnTools = allowlistForLockedEmployeeTurn(
            askEmployee.tools,
            connectedChannelsList,
            askEmployee.role,
          );
        }
        break;
      }
      case 'team': {
        // Team turn uses per-specialist locked allowlists in streamCrewAnswer.
        askEmployee = null;
        turnTools = [];
        break;
      }
      case 'auto': {
        askEmployee = routeAskEmployee(orgId, promptStr, employeeRows);
        // Card allowlist + core + channels on card — never org-union when a
        // specific employee was selected (including custom / Research / Executive).
        turnTools = askEmployee
          ? allowlistForLockedEmployeeTurn(
              askEmployee.tools,
              connectedChannelsList,
              askEmployee.role,
            )
          : allowlistForEmployeeTurn(
              orgTools,
              orgTools,
              connectedChannelsList,
              undefined,
            );
        routing = withAutoRoutingReason(routing, askEmployee?.name, askEmployee?.reason);
        break;
      }
      default: {
        const _exhaustive: never = askSelection.turnMode;
        return _exhaustive;
      }
    }

    const lockedHandoff =
      askSelection.turnMode === 'single' || askSelection.turnMode === 'team'
        ? resolveLockedHandoff(
            askSelection.turnEmployees.map((e) => String(e.role || '')),
            promptStr,
          ) ??
          resolveCustomHandoff(
            askSelection.turnEmployees.map((e) => ({
              role: e.role,
              name: e.name,
              allowlist: Array.isArray(e.tool_allowlist)
                ? e.tool_allowlist.map((t) => String(t))
                : [],
            })),
            promptStr,
          )
        : null;

    if (lockedHandoff) {
      return streamHandoffAnswer({
        orgId,
        conversationId,
        prompt: promptStr,
        handoff: lockedHandoff,
        routing,
        askEmployee,
        contextLoadFailed,
      });
    }

    const explicitPlanRequested =
      Boolean((body as Record<string, unknown>)?.mode === 'plan') ||
      /^\s*(\/plan|plan:)/i.test(promptStr) ||
      /\b(create|generate|draft|make)\s+(a\s+|an\s+)?(plan|execution plan|playbook)\b/i.test(promptStr);

    const classification = await classifyRequest(promptStr, orgId);
    const promotions = await withOrgClient(orgId, (c) => loadOrgPromotedPlaybooks(c, orgId));
    const shipPlaybook = classification.playbookId ? getPlaybook(classification.playbookId) : null;
    const orgPlaybook = shipPlaybook
      ? null
      : matchOrgPromotedPlaybook(promptStr, promotions) ||
        promotions.find((p) => p.playbookId === classification.playbookId) ||
        null;
    if (orgPlaybook && !shipPlaybook) {
      classification.type = 'complex';
      classification.playbookId = orgPlaybook.playbookId;
    }

    const matchedPlaybook = shipPlaybook || orgPlaybook;
    const shouldGeneratePlan = explicitPlanRequested || Boolean(classification.type === 'complex' && matchedPlaybook);

    // ── COMPLEX: generate plan + draft, persist, present for approval ──────
    // Only intercept with a static PlanCard if the user explicitly requested a plan
    // or an explicit playbook was matched. Otherwise, stream through TrueForge autonomous agent!
    if (shouldGeneratePlan) {
      try {
        const playbook = classification.playbookId ? getPlaybook(classification.playbookId) : null;
        const generated = playbook
          ? playbookToPlan(playbook, String(prompt))
          : orgPlaybook
            ? orgPlaybookToPlan(orgPlaybook, String(prompt))
            : await generatePlan(String(prompt), orgId, connectedChannelsList);

        const autoActor =
          askSelection.turnMode === 'auto'
            ? autoPlanEmployee(orgEmployeeRows, askEmployee?.id)
            : null;
        const stampedSteps = autoActor
          ? stampPlanStepsForMode(generated.steps, 'single', [autoActor])
          : stampPlanStepsForMode(
              generated.steps,
              askSelection.turnMode,
              askSelection.turnEmployees,
            );
        const planForPersist = { ...generated, steps: stampedSteps };

        const planId = crypto.randomUUID();
        await withOrgClient(orgId, async (writeClient) => {
          await client2InsertPlan(writeClient, planId, orgId, userId, conversationId, planForPersist, classification);
          if (conversationId) {
            await insertAskAiMessage(
              writeClient,
              orgId,
              conversationId,
              'assistant',
              planForPersist.summary || 'Plan ready for approval',
              {
                type: 'complex',
                planId,
                playbookId: classification.playbookId || null,
                summary: planForPersist.summary,
                steps: planForPersist.steps,
                draft: planForPersist.draft,
                reasoning: planForPersist.reasoning,
                routing,
              }
            );
          }
        });

        if (planRequiresDurableExecute(planForPersist.steps)) {
          void startPlanExecuteWorkflow({
            orgId,
            planId,
            waitForApproval: true,
            idempotencyKey: planId,
          });
        }

        logLangfuseTrace({
          name: 'PlanGenerated',
          orgId,
          input: { prompt, classification: classification.type, confidence: classification.confidence, connectedChannels: connectedChannelsList, playbookId: classification.playbookId },
          output: { planId, summary: planForPersist.summary, steps: planForPersist.steps, reasoning: planForPersist.reasoning },
          metadata: { planId, usedFallback: classification.usedFallback, playbookId: classification.playbookId },
          provider: playbook ? 'playbook' : 'litellm',
        }).catch(() => {});

        return NextResponse.json({
          type: 'complex',
          classification: { confidence: classification.confidence, usedFallback: classification.usedFallback, playbookId: classification.playbookId || null },
          planId,
          conversationId,
          provider: 'TrueForge',
          reasoning: planForPersist.reasoning,
          summary: planForPersist.summary,
          steps: planForPersist.steps,
          draft: planForPersist.draft,
          routing,
          employeeName: askEmployee?.name || routing.employeeNames[0] || null,
          employeeRole: askEmployee?.role || null,
          routeReason: routing.reason,
          proposedAction: null,
          error: null,
          retryable: false,
          partialReply: null,
          ...(contextLoadFailed
            ? {
                warning:
                  'Previous thread context could not be loaded from the database. This reply may lack conversation history.',
              }
            : {}),
        });
      } catch (planErr: any) {
        // Planner failed — degrade gracefully to a streamed inline agent answer.
        console.error('Plan generation failed, falling back to direct answer:', planErr.message);
        return streamSimpleAnswer({
          orgId,
          userId,
          conversationId,
          prompt: String(prompt),
          orgName,
          currentUserEmail,
          connectedChannelsList,
          fallbackReason: planErr.message,
          priorMessages,
          contextLoadFailed,
          askEmployee,
          toolAllowlist: turnTools,
          routing,
          signal: request.signal,
        });
      }
    }

    const roster = rosterFromEmployeeRows(employeeRows);

    if (askSelection.turnMode === 'team' && askSelection.turnEmployees.length > 0) {
      const teamPlan = fixedTeamCrewPlan(promptStr, askSelection.turnEmployees);
      return streamCrewAnswer({
        orgId,
        userId,
        conversationId,
        prompt: promptStr,
        connectedChannelsList,
        orgTools: [], // locked path — never org-union
        roster,
        plan: teamPlan,
        lockedAllowlists: true,
        fixedMembers: true,
        routing,
        contextLoadFailed,
        signal: request.signal,
      });
    }

    if (askSelection.turnMode === 'auto') {
      const crewHint = heuristicCrewPlan(promptStr, roster);
      if (crewHint.mode === 'crew') {
        return streamCrewAnswer({
          orgId,
          userId,
          conversationId,
          prompt: promptStr,
          connectedChannelsList,
          orgTools,
          roster,
          plan: crewHint,
          lockedAllowlists: false,
          routing: withAutoRoutingReason(routing, undefined, crewHint.reason),
          contextLoadFailed,
          signal: request.signal,
        });
      }
    }

    return streamSimpleAnswer({
      orgId,
      userId,
      conversationId,
      prompt: String(prompt),
      orgName,
      currentUserEmail,
      connectedChannelsList,
      priorMessages,
      contextLoadFailed,
      askEmployee,
      toolAllowlist: turnTools,
      routing,
      signal: request.signal,
    });
  } catch (error: any) {
    if (client) client.release();
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

function rosterFromEmployeeRows(
  rows: Array<{
    id?: string;
    name?: string;
    role?: string;
    persona?: unknown;
    tool_allowlist?: unknown;
    status?: string;
  }>,
): CrewRosterMember[] {
  // Callers must not assume roster.length === rows.length.
  const { valid, droppedCount } = filterValidEmployeeRows(rows);
  if (droppedCount > 0) {
    console.warn(
      `[Ask AI] rosterFromEmployeeRows dropped ${droppedCount} row(s) missing id/name (input=${rows.length}, roster=${valid.length})`,
    );
  }
  return valid.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    role: String(row.role || ''),
    persona: personaPlain(row.persona) || String(row.role || 'AI employee'),
    tool_allowlist: allowlistPlainPublic(row.tool_allowlist),
    status: row.status,
  }));
}

function streamHandoffAnswer(args: {
  orgId: string;
  conversationId: string;
  prompt: string;
  handoff: HandoffOffer;
  routing: AskRouting;
  askEmployee?: AskEmployee | null;
  contextLoadFailed?: boolean;
}): Response {
  const encoder = new TextEncoder();
  const fromName = args.askEmployee?.name || args.routing.employeeNames[0] || 'This employee';
  const answer =
    `${fromName} does not own this request. ${args.handoff.reason} ` +
    `Hand it to someone with the role “${args.handoff.toRole}” — use Hand to below, then send when you are ready.`;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify({ type: eventType, ...payload }) + '\n'));
      };
      try {
        send('routing', { routing: args.routing });
        if (args.contextLoadFailed) {
          send('warning', {
            code: 'context_load_failed',
            message:
              'Previous thread context could not be loaded from the database. This reply may lack conversation history.',
          });
        }
        send('chunk', { text: answer });
        if (args.conversationId) {
          try {
            await persistAskAiMessage(args.orgId, args.conversationId, 'assistant', answer, {
              type: 'simple',
              handoff: args.handoff,
              routing: args.routing,
            });
          } catch (err: unknown) {
            console.warn(
              '[Ask AI] Failed to persist handoff reply:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        send('done', {
          conversationId: args.conversationId,
          classification: 'simple',
          provider: 'DareX',
          answer,
          routing: args.routing,
          handoff: args.handoff,
          employeeName: args.askEmployee?.name || null,
          employeeRole: args.askEmployee?.role || null,
          routeReason: args.routing.reason || null,
          usedTools: [],
          executedSteps: [],
          error: null,
          retryable: false,
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

function streamCrewAnswer(args: {
  orgId: string;
  userId: string;
  conversationId: string;
  prompt: string;
  connectedChannelsList: string[];
  orgTools: string[];
  roster: CrewRosterMember[];
  plan: CrewPlan;
  /** When true, each specialist gets only their own allowlist + core + connected (no org union). */
  lockedAllowlists?: boolean;
  /**
   * Ask AI Team mode: keep the user-selected specialists (cap 3), no planCrew
   * replacement, no silent drop, no greeting collapse to a solo executive.
   */
  fixedMembers?: boolean;
  routing: AskRouting;
  contextLoadFailed?: boolean;
  signal?: AbortSignal;
}): Response {
  const lease = tryAcquireConcurrency(args.orgId, 'ask_ai');
  if (!lease) return denyAskAiBusy();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Guard enqueue after close/error — late async work must not throw.
      let streamOpen = true;
      const send = (eventType: string, payload: Record<string, unknown>) => {
        if (!streamOpen) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ type: eventType, ...payload }) + '\n'));
        } catch {
          streamOpen = false;
        }
      };
      const startedAt = Date.now();
      try {
        send('routing', { routing: args.routing });
        if (args.contextLoadFailed) {
          send('warning', {
            code: 'context_load_failed',
            message:
              'Previous thread context could not be loaded from the database. This reply may lack conversation history.',
          });
        }

        const stamp = `ask-crew:${Date.now()}`;
        const { resolved, unmatchedEmployeeIds, inactiveEmployeeIds } = resolveCrewAssignments(
          args.plan.specialists,
          args.roster,
        );
        if (unmatchedEmployeeIds.length > 0) {
          console.warn(
            `[Ask AI] crew plan referenced unknown employeeId(s): ${unmatchedEmployeeIds.join(', ')}`,
          );
          send('warning', {
            code: 'crew_unmatched_employee',
            message: `Crew plan skipped ${unmatchedEmployeeIds.length} unknown employee assignment(s).`,
            employeeIds: unmatchedEmployeeIds,
          });
        }
        if (inactiveEmployeeIds.length > 0) {
          console.warn(
            `[Ask AI] crew plan skipped inactive employeeId(s) before dispatch: ${inactiveEmployeeIds.join(', ')}`,
          );
          send('warning', {
            code: 'crew_inactive_employee',
            message: `Crew plan skipped ${inactiveEmployeeIds.length} inactive employee(s).`,
            employeeIds: inactiveEmployeeIds,
          });
        }

        const specialistAllowlist = (emp: CrewRosterMember) =>
          args.lockedAllowlists
            ? allowlistForLockedEmployeeTurn(emp.tool_allowlist, args.connectedChannelsList, emp.role)
            : allowlistForEmployeeTurn(
                emp.tool_allowlist,
                args.orgTools,
                args.connectedChannelsList,
                emp.role,
              );

        const specialists: AgentTaskInput[] = resolved.map(({ assignment, employee: emp }) => ({
          orgId: args.orgId,
          userId: args.userId,
          employeeId: emp.id,
          employeeName: emp.name,
          employeeRole: emp.role,
          employeePersona: emp.persona,
          toolAllowlist: specialistAllowlist(emp),
          connectedChannels: args.connectedChannelsList,
          userMessage: assignment.task || args.prompt,
          sessionKey: `${stamp}:${emp.id}`,
          skipPersist: true,
        }));

        const activeRoster = args.roster.filter(isActiveCrewMember);
        const managerEmp = resolved[0]?.employee || activeRoster[0];
        if (!managerEmp) {
          send('error', {
            error: 'No active employees available to run this crew.',
            retryable: false,
          });
          return;
        }

        const manager: AgentTaskInput = {
          orgId: args.orgId,
          userId: args.userId,
          conversationId: args.conversationId || undefined,
          employeeId: managerEmp.id,
          employeeName: managerEmp.name,
          employeeRole: managerEmp.role,
          employeePersona: managerEmp.persona,
          toolAllowlist: specialistAllowlist(managerEmp),
          connectedChannels: args.connectedChannelsList,
          userMessage: args.prompt,
          sessionKey: `${stamp}:manager`,
          skipPersist: true,
        };
        const crewInput: CrewWorkflowInput = {
          orgId: args.orgId,
          conversationId: args.conversationId || undefined,
          userMessage: args.prompt,
          idempotencyKey: stamp,
          reason: args.plan.reason,
          manager,
          specialists,
          ...(args.fixedMembers ? { fixedMembers: true } : {}),
        };

        // ASK-E01: who dispatched which crew. Each member's tools are gated and audited on their own.
        await recordAuditEvent({
          orgId: args.orgId,
          kind: 'crew.dispatch',
          actor: { actorType: 'user', userId: args.userId },
          resultStatus: 'ok',
          payload: {
            crewKey: crewInput.idempotencyKey,
            conversationId: args.conversationId || null,
            reason: crewInput.reason ?? null,
            managerEmployeeId: crewInput.manager.employeeId ?? null,
            specialistEmployeeIds: crewInput.specialists.map((s) => s.employeeId ?? null),
          },
        }).catch((auditErr: unknown) =>
          console.warn('crew.dispatch audit failed:', auditErr instanceof Error ? auditErr.message : auditErr),
        );

        for (const spec of specialists) {
          send('subagent', {
            subagent: {
              threadId: spec.employeeId,
              title: spec.employeeName,
              name: spec.employeeName,
              instruction: spec.userMessage,
              status: 'started',
              createdAt: new Date().toISOString(),
            },
          });
          send('tool', { tool: 'subagent_start', label: `Started ${spec.employeeName}` });
        }

        let usedTemporal = false;
        let result: CrewWorkflowResult;
        const handle = await startCrewWorkflow(crewInput);
        if (handle) {
          usedTemporal = true;
          result = args.signal
            ? await awaitCrewHandleWithAbort(handle, args.signal)
            : await handle.result();
        } else {
          // Propagate Stop / disconnect into specialist + manager turns.
          result = await runCrewDirect(crewInput, { signal: args.signal });
        }
        if (args.signal?.aborted) return;

        const subagents = (result.spawned || []).flatMap((spawn) => {
          const threadId = spawn.employeeId || spawn.employeeName;
          const createdAt = new Date().toISOString();
          const failed = spawn.result.success === false;
          const endStatus = failed ? ('error' as const) : ('done' as const);
          return [
            {
              threadId,
              title: spawn.employeeName,
              name: spawn.employeeName,
              instruction: spawn.task,
              status: 'started' as const,
              createdAt,
            },
            {
              threadId,
              title: spawn.employeeName,
              name: spawn.employeeName,
              instruction: spawn.task,
              status: endStatus,
              durationMs: Date.now() - startedAt,
              createdAt,
              error: failed ? publicErrorMessage(spawn.result.error || spawn.result.replyMessage, 'Specialist failed') : undefined,
            },
          ];
        });
        for (const spawn of result.spawned || []) {
          const failed = spawn.result.success === false;
          const errMsg = publicErrorMessage(spawn.result.error || spawn.result.replyMessage, 'Specialist failed');
          send('subagent', {
            subagent: {
              threadId: spawn.employeeId || spawn.employeeName,
              title: spawn.employeeName,
              name: spawn.employeeName,
              instruction: spawn.task,
              status: failed ? 'error' : 'done',
              durationMs: Date.now() - startedAt,
              createdAt: new Date().toISOString(),
              ...(failed ? { error: errMsg } : {}),
            },
          });
          if (failed) {
            send('tool', { tool: 'subagent_error', label: `${spawn.employeeName} failed: ${errMsg}` });
          } else {
            send('tool', { tool: 'subagent_done', label: spawn.employeeName });
          }
        }

        const answer = sanitizeAgentReply(result.replyMessage);
        if (answer) send('chunk', { text: answer });

        const executedSteps = (result.spawned || []).flatMap((spawn, index) => {
          const threadId = spawn.employeeId || spawn.employeeName;
          const failed = spawn.result.success === false;
          const inner = (spawn.result.executedSteps || []).map((step, stepIndex) => ({
            step: stepIndex + 1,
            action: step.action,
            toolUsed: step.toolUsed || step.action,
            result: step.result,
            threadId,
          }));
          return [
            { step: index * 100, action: 'subagent_start', toolUsed: 'subagent_start', result: spawn.employeeName, threadId },
            ...inner,
            {
              step: index * 100 + 99,
              action: failed ? 'subagent_error' : 'subagent_done',
              toolUsed: failed ? 'subagent_error' : 'subagent_done',
              result: failed
                ? publicErrorMessage(spawn.result.error || spawn.result.replyMessage, 'Specialist failed')
                : threadId,
              threadId,
            },
          ];
        });

        if (args.conversationId && !usedTemporal && answer) {
          try {
            await persistAskAiMessage(args.orgId, args.conversationId, 'assistant', answer, {
              type: 'simple',
              usedTools: result.usedTools,
              executedSteps,
              crew: true,
              routing: args.routing,
            });
          } catch (err: unknown) {
            console.warn('[Ask AI] Failed to persist crew reply:', err instanceof Error ? err.message : err);
          }
        }

        send('done', {
          conversationId: args.conversationId,
          classification: 'simple',
          provider: 'TrueForge',
          answer,
          routing: args.routing,
          employeeName: 'Crew',
          employeeRole: args.plan.reason,
          routeReason: args.routing.reason || args.plan.reason,
          usedTools: result.usedTools,
          executedSteps,
          subagents,
          error: result.success === false ? result.replyMessage : null,
          retryable: result.success === false,
        });
      } catch (err: unknown) {
        if (args.signal?.aborted) return;
        const message = err instanceof Error ? err.message : 'Crew failed';
        send('error', { error: message, retryable: true });
      } finally {
        // Always release the concurrency lease — success, error, and abort.
        lease.release();
        streamOpen = false;
        try {
          controller.close();
        } catch {
          // already closed/errored
        }
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

function streamSimpleAnswer(args: {
  orgId: string;
  userId: string;
  conversationId: string;
  prompt: string;
  orgName: string;
  currentUserEmail: string;
  connectedChannelsList: string[];
  fallbackReason?: string;
  priorMessages?: Array<{ role: string; content: string }>;
  contextLoadFailed?: boolean;
  askEmployee?: AskEmployee | null;
  toolAllowlist: string[];
  routing: AskRouting;
  signal?: AbortSignal;
}): Response {
  const lease = tryAcquireConcurrency(args.orgId, 'ask_ai');
  if (!lease) {
    return denyAskAiBusy();
  }

  const sessionKey = dailySessionKey(args.orgId, args.userId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify({ type: eventType, ...payload }) + '\n'));
      };

      try {
        send('routing', { routing: args.routing });
        if (args.contextLoadFailed) {
          send('warning', {
            code: 'context_load_failed',
            message:
              'Previous thread context could not be loaded from the database. This reply may lack conversation history.',
          });
        }
        const retrievedMemory = await retrieveMemory({
          orgId: args.orgId,
          query: args.prompt,
          conversationId: args.conversationId || undefined,
          // Persona tier exclusions and the employee tier need these (MEM-B07).
          employeeId: args.askEmployee?.id || undefined,
          employeeRole: args.askEmployee?.role || undefined,
        });
        const result = await runAutonomousAgentDirect(
          {
            orgId: args.orgId,
            userId: args.userId,
            conversationId: args.conversationId || undefined,
            sessionKey,
            employeeId: args.askEmployee?.id,
            employeeName: args.askEmployee?.name || 'DareX Executive',
            employeeRole: args.askEmployee?.role || 'Primary Business Assistant',
            employeePersona: buildPersona(
              args.orgName,
              args.currentUserEmail,
              args.connectedChannelsList,
              args.orgId,
              args.askEmployee,
            ),
            connectedChannels: args.connectedChannelsList,
            toolAllowlist: args.toolAllowlist,
            userMessage: args.prompt,
          },
          {
            timeoutMs: 120000,
            priorMessages: args.priorMessages,
            retrievedMemory,
            signal: args.signal,
            onChunk: (text) => send('chunk', { text }),
            onToolProgress: (tool, label) => send('tool', { tool, label }),
            onSubagent: (ev) => send('subagent', { subagent: ev }),
          }
        );

        if (args.signal?.aborted) return;

        const answer = sanitizeAgentReply(result.replyMessage);
        await logLangfuseTrace({
          name: args.fallbackReason ? 'AskAI-PlanFallback' : 'AskAI-AutonomousExecution',
          orgId: args.orgId,
          input: args.fallbackReason
            ? { prompt: args.prompt, reason: args.fallbackReason }
            : { prompt: args.prompt },
          output: answer,
          metadata: {
            usedTools: result.usedTools,
            steps: result.executedSteps.length,
            approvalsRequested: result.executedSteps.filter((s: any) => s.toolUsed === 'approval_required' || s.action === 'approval_required').length,
            employeeId: args.askEmployee?.id || null,
          },
          // Usage was dropped here, so the llm_tokens meter never filled (RT-B13).
          model: 'darex-agent',
          usage: result.usage
            ? {
                input: result.usage.inputTokens,
                output: result.usage.outputTokens,
                total: result.usage.totalTokens,
              }
            : undefined,
          costUsd: turnSpendCents(result.usage) / 100,
        }).catch(console.error);

        if (args.conversationId) {
          try {
            await persistAskAiMessage(args.orgId, args.conversationId, 'assistant', answer, {
              type: 'simple',
              usedTools: result.usedTools,
              executedSteps: result.executedSteps,
              trajectory: result.executedSteps.map((s: any) => ({
                step: s.step,
                thought: s.action,
                action: s.toolUsed || 'reason',
                observation: s.result,
              })),
              error: result.error ? publicErrorMessage(result.error) : null,
              retryable: result.retryable || false,
              routing: args.routing,
            });
          } catch (err: any) {
            console.warn('[Ask AI] Failed to persist assistant message:', err?.message);
          }
          if (result.success && answer) {
            void startMemoryWriteBackWorkflow({
              orgId: args.orgId,
              conversationId: args.conversationId,
              closed: false,
              toolResults: result.executedSteps,
              businessKey: `ask-ai:${args.conversationId}:${Date.now()}`,
            });
          }
        }

        // Paused-for-approval turns surface resumable requests (with the
        // session id) instead of looking done. The client renders
        // Approve/Deny per item and POSTs to /api/ask-ai/approve.
        if (result.approvals && result.approvals.length > 0 && result.sessionId) {
          send('approval', {
            conversationId: args.conversationId,
            sessionId: result.sessionId,
            approvals: result.approvals,
          });
        }

        send('done', {
          conversationId: args.conversationId,
          classification: 'simple',
          provider: (result as any).provider || 'TrueForge',
          sessionId: result.sessionId || null,
          approvals: result.approvals || [],
          subagents: result.subagents || [],
          confidence: 1.0,
          usedFallback: false,
          answer,
          routing: args.routing,
          employeeName: args.askEmployee?.name || null,
          employeeRole: args.askEmployee?.role || null,
          routeReason: args.routing.reason || args.askEmployee?.reason || null,
          usedTools: result.usedTools,
          executedSteps: result.executedSteps,
          trajectory: result.executedSteps.map((s: any) => ({
            step: s.step,
            thought: s.action,
            action: s.toolUsed || 'reason',
            observation: s.result,
          })),
          proposedAction: null,
          error: result.error ? publicErrorMessage(result.error) : null,
          retryable: result.retryable || false,
          partialReply: result.partialReply || null,
        });
      } catch (err: any) {
        if (args.conversationId) {
          try {
            await persistAskAiMessage(args.orgId, args.conversationId, 'assistant', `❌ ${err.message || 'An error occurred'}`, {
              type: 'simple',
              error: publicErrorMessage(err),
              retryable: true,
            });
          } catch (persistErr: any) {
            console.warn('[Ask AI] Failed to persist assistant error message:', persistErr?.message);
          }
        }
        send('error', { error: publicErrorMessage(err), retryable: true });
      } finally {
        lease.release();
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

export async function GET(request: Request) {
  let client: PoolClient | null = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    let orgName = 'Your Business';
    let connectedChannels: string[] = [];
    try {
      const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
      orgName = orgRes.rows[0]?.name || 'Your Business';
      const chanRes = await client.query(
        "SELECT channel_type FROM channels WHERE org_id = $1 AND (status = 'active' OR status = 'connected')",
        [orgId]
      );
      connectedChannels = chanRes.rows.map((r: { channel_type: string }) => r.channel_type);
    } catch (ctxErr: unknown) {
      console.warn(
        '[Ask AI] GET context query failed:',
        ctxErr instanceof Error ? ctxErr.message : ctxErr
      );
    }

    const { searchParams } = new URL(request.url);
    const requestedConversationId = searchParams.get('conversationId');

    let conversationId: string;
    let conversationSummary = 'Ask AI';
    let askMode: AskMode = 'auto';
    let askEmployeeIds: string[] = [];

    if (requestedConversationId && UUID_RE.test(requestedConversationId)) {
      const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
      const found = await client.query(
        `SELECT id, summary FROM conversations
         WHERE id = $1 AND org_id = $2
           AND (
             contact_id = $3
             OR (metadata->>'source' = 'ask-ai' AND metadata->>'userId' = $4)
           )
         LIMIT 1`,
        [requestedConversationId, orgId, contactId, userId]
      );
      if (found.rows[0]?.id) {
        conversationId = found.rows[0].id;
        conversationSummary = found.rows[0].summary || 'Ask AI';
      } else {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }
    } else {
      const ensured = await ensureAskAiConversation(client, orgId, userId);
      conversationId = ensured.id;
      conversationSummary = ensured.summary;
    }

    const savedAsk = await loadConversationAskMode(client, conversationId);
    askMode = savedAsk.mode;
    askEmployeeIds = savedAsk.employeeIds;
    if (savedAsk.unset) {
      const prefs = await loadUserAskModePrefs(client, orgId, userId);
      if (prefs.mode !== 'auto' || prefs.employeeIds.length > 0) {
        askMode = prefs.mode;
        askEmployeeIds = prefs.employeeIds;
      }
    }

    const msgRes = await client.query(
      `SELECT id, role, content, tool_calls, created_at FROM (
         SELECT id, role, content, tool_calls, created_at
         FROM messages
         WHERE org_id = $1 AND conversation_id = $2
         ORDER BY created_at DESC
         LIMIT 200
       ) sub ORDER BY created_at ASC`,
      [orgId, conversationId]
    );
    const planQuery = requestedConversationId
      ? `SELECT * FROM agent_plans
         WHERE org_id = $1 AND user_id = $2
           AND thread_id = $3
           AND status IN ('pending', 'approved', 'running', 'completed', 'completed_with_errors')
         ORDER BY created_at DESC
         LIMIT 20`
      : `SELECT * FROM agent_plans
         WHERE org_id = $1 AND user_id = $2
           AND (thread_id = $3 OR thread_id = 'ask-ai')
           AND status IN ('pending', 'approved', 'running', 'completed', 'completed_with_errors')
         ORDER BY created_at DESC
         LIMIT 20`;
    const planRes = await client.query(planQuery, [orgId, userId, conversationId]);

    return NextResponse.json({
      conversationId,
      conversationSummary,
      askMode,
      askEmployeeIds,
      orgName,
      connectedChannels,
      messages: msgRes.rows.map((row: any) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        toolCalls: row.tool_calls,
        createdAt: row.created_at,
      })),
      plans: planRes.rows,
    });
  } catch (error: any) {
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('GET /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
