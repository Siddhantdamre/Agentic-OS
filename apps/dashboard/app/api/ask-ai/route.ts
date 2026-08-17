import { NextResponse } from 'next/server';
import { getScopedClient, pool } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { classifyRequest } from '@/lib/classify';
import { generatePlan, VALID_TOOLS } from '@/lib/plan-generator';
import { getPlaybook, playbookToPlan } from '@/lib/playbook-matcher';
import {
  loadOrgPromotedPlaybooks,
  matchOrgPromotedPlaybook,
  orgPlaybookToPlan,
} from '@/lib/insight-engine';
import {
  denyAskAiBusy,
  denyAskAiIfLimited,
  isRateLimitError,
  responseFromRateLimit,
  tryAcquireConcurrency,
} from '@/lib/rate-limit';
import {
  runAutonomousAgentDirect,
  sanitizeAgentReply,
} from '@darex/workflows/dist/atomic-agent-client';
import { retrieveMemory } from '@darex/workflows/dist/memory/retrieve';
import { planRequiresDurableExecute } from '@darex/workflows/dist/plan-steps';
import { startMemoryWriteBackWorkflow, startPlanExecuteWorkflow } from '@darex/workflows/dist/workflow-client';
import type { PoolClient } from 'pg';

export const dynamic = 'force-dynamic';

const ASK_AI_CONTACT_PREFIX = 'ask-ai:';

const SIMPLE_TOOL_ALLOWLIST = Array.from(
  new Set<string>([
    ...VALID_TOOLS,
    'code_execution',
    'execute_code',
    'db_query',
    'sql_analytics',
    'workspace_file',
    'file_system',
  ])
);

function dailySessionKey(userId: string): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `askai-${userId}-${day}`;
}

function buildPersona(
  orgName: string,
  currentUserEmail: string,
  connectedChannels: string[],
  orgId: string
): string {
  const connected =
    connectedChannels.length > 0
      ? connectedChannels.join(', ')
      : 'none — do not invent connector data; tell the user to connect tools at /connectors';
  return `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. Connected connectors: ${connected}. Core tools always available: database_query, web_search, web_extract, file_ops. Act decisively and execute tools when needed. Your org_id is ${orgId} — always pass it to mcp.darex.database_query and mcp.darex.database_execute, and never search memory to find it.`;
}

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pc = await pool.connect();
  try {
    await pc.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(pc);
  } finally {
    try {
      await pc.query('RESET app.current_org_id');
    } catch {
      // ignore reset failure — release still happens
    }
    pc.release();
  }
}

async function ensureAskAiConversation(
  client: PoolClient,
  orgId: string,
  userId: string
): Promise<string> {
  const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
  const existing = await client.query(
    `SELECT id FROM conversations
     WHERE org_id = $1 AND contact_id = $2 AND metadata->>'source' = 'ask-ai'
     ORDER BY updated_at DESC LIMIT 1`,
    [orgId, contactId]
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await client.query(
    `INSERT INTO conversations (org_id, contact_id, status, summary, metadata, started_at, updated_at)
     VALUES ($1, $2, 'open', 'Ask AI', $3::jsonb, NOW(), NOW())
     RETURNING id`,
    [orgId, contactId, JSON.stringify({ source: 'ask-ai', userId })]
  );
  return created.rows[0].id;
}

async function resolveConversationId(
  client: PoolClient,
  orgId: string,
  userId: string,
  requestedId?: string
): Promise<string> {
  if (requestedId) {
    const found = await client.query(
      `SELECT id FROM conversations WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [requestedId, orgId]
    );
    if (found.rows[0]?.id) return found.rows[0].id;
  }
  return ensureAskAiConversation(client, orgId, userId);
}

async function insertAskAiMessage(
  client: PoolClient,
  orgId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [orgId, conversationId, role, content, toolCalls ? JSON.stringify(toolCalls) : null]
  );
  await client.query(
    `UPDATE conversations SET updated_at = NOW(), summary = $3 WHERE id = $1 AND org_id = $2`,
    [conversationId, orgId, content.slice(0, 100)]
  );
}

async function persistAskAiMessage(
  orgId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  toolCalls?: unknown
): Promise<void> {
  await withOrgClient(orgId, (c) => insertAskAiMessage(c, orgId, conversationId, role, content, toolCalls));
}

async function client2InsertPlan(
  client: PoolClient,
  planId: string,
  orgId: string,
  userId: string,
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
     VALUES ($1, $2, $3, 'ask-ai', $4, $5, 'pending', 0, $6, $7, NOW(), NOW())`,
    [
      planId,
      orgId,
      userId,
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

    const limited = denyAskAiIfLimited(orgId);
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

    } catch {
      // Continue if context queries fail
    }

    const body = await request.json();
    const prompt = body?.prompt;
    const requestedConversationId =
      typeof body?.conversationId === 'string' ? body.conversationId : undefined;
    if (!prompt) {
      release();
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    let conversationId = requestedConversationId || '';
    try {
      conversationId = await resolveConversationId(client, orgId, userId, requestedConversationId);
      await insertAskAiMessage(client, orgId, conversationId, 'user', String(prompt));
    } catch (persistErr: any) {
      console.warn('[Ask AI] Failed to persist user message:', persistErr?.message);
    }

    // Release before classify / plan / agent — those are slow and must not hold a pool slot.
    release();

    const classification = await classifyRequest(String(prompt), orgId);
    const promotions = await withOrgClient(orgId, (c) => loadOrgPromotedPlaybooks(c, orgId));
    const shipPlaybook = classification.playbookId ? getPlaybook(classification.playbookId) : null;
    const orgPlaybook = shipPlaybook
      ? null
      : matchOrgPromotedPlaybook(String(prompt), promotions) ||
        promotions.find((p) => p.playbookId === classification.playbookId) ||
        null;
    if (orgPlaybook && !shipPlaybook) {
      classification.type = 'complex';
      classification.playbookId = orgPlaybook.playbookId;
    }

    // ── COMPLEX: generate plan + draft, persist, present for approval ──────
    if (classification.type === 'complex') {
      try {
        const playbook = classification.playbookId ? getPlaybook(classification.playbookId) : null;
        const generated = playbook
          ? playbookToPlan(playbook, String(prompt))
          : orgPlaybook
            ? orgPlaybookToPlan(orgPlaybook, String(prompt))
            : await generatePlan(String(prompt), orgId, connectedChannelsList);

        const planId = crypto.randomUUID();
        await withOrgClient(orgId, async (writeClient) => {
          await client2InsertPlan(writeClient, planId, orgId, userId, generated, classification);
          if (conversationId) {
            await insertAskAiMessage(
              writeClient,
              orgId,
              conversationId,
              'assistant',
              generated.summary || 'Plan ready for approval',
              {
                type: 'complex',
                planId,
                playbookId: classification.playbookId || null,
                summary: generated.summary,
                steps: generated.steps,
                draft: generated.draft,
                reasoning: generated.reasoning,
              }
            );
          }
        });

        if (planRequiresDurableExecute(generated.steps)) {
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
          output: { planId, summary: generated.summary, steps: generated.steps, reasoning: generated.reasoning },
          metadata: { planId, usedFallback: classification.usedFallback, playbookId: classification.playbookId },
          provider: playbook ? 'playbook' : 'litellm',
        }).catch(() => {});

        return NextResponse.json({
          type: 'complex',
          classification: { confidence: classification.confidence, usedFallback: classification.usedFallback, playbookId: classification.playbookId || null },
          planId,
          conversationId,
          provider: 'Atomic Agent',
          reasoning: generated.reasoning,
          summary: generated.summary,
          steps: generated.steps,
          draft: generated.draft,
          proposedAction: null,
          error: null,
          retryable: false,
          partialReply: null,
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
    });
  } catch (error: any) {
    if (client) client.release();
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
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
}): Response {
  const lease = tryAcquireConcurrency(args.orgId, 'ask_ai');
  if (!lease) {
    return denyAskAiBusy();
  }

  const sessionKey = dailySessionKey(args.userId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(JSON.stringify({ type: eventType, ...payload }) + '\n'));
      };

      try {
        const retrievedMemory = await retrieveMemory({
          orgId: args.orgId,
          query: args.prompt,
          conversationId: args.conversationId || undefined,
        });
        const result = await runAutonomousAgentDirect(
          {
            orgId: args.orgId,
            conversationId: args.conversationId || undefined,
            sessionKey,
            employeeName: 'DareX Executive',
            employeeRole: 'Primary Business Assistant',
            employeePersona: buildPersona(
              args.orgName,
              args.currentUserEmail,
              args.connectedChannelsList,
              args.orgId
            ),
            connectedChannels: args.connectedChannelsList,
            toolAllowlist: SIMPLE_TOOL_ALLOWLIST,
            userMessage: args.prompt,
          },
          {
            timeoutMs: 120000,
            retrievedMemory,
            onChunk: (text) => send('chunk', { text }),
            onToolProgress: (tool, label) => send('tool', { tool, label }),
          }
        );

        const answer = sanitizeAgentReply(result.replyMessage);
        await logLangfuseTrace({
          name: args.fallbackReason ? 'AskAI-PlanFallback' : 'AskAI-AutonomousExecution',
          orgId: args.orgId,
          input: args.fallbackReason
            ? { prompt: args.prompt, reason: args.fallbackReason }
            : { prompt: args.prompt },
          output: answer,
          metadata: { usedTools: result.usedTools, steps: result.executedSteps.length },
        }).catch(console.error);

        if (args.conversationId) {
          persistAskAiMessage(args.orgId, args.conversationId, 'assistant', answer, {
            type: 'simple',
            usedTools: result.usedTools,
            error: result.error || null,
            retryable: result.retryable || false,
          }).catch((err) => console.warn('[Ask AI] Failed to persist assistant message:', err?.message));
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

        send('done', {
          classification: 'simple',
          conversationId: args.conversationId,
          answer,
          provider: 'Atomic Agent',
          usedTools: result.usedTools,
          executedSteps: result.executedSteps,
          trajectory: result.executedSteps.map((s: any) => ({
            step: s.step,
            thought: s.action,
            action: s.toolUsed || 'reason',
            observation: s.result,
          })),
          proposedAction: null,
          error: result.error || null,
          retryable: result.retryable || false,
          partialReply: result.partialReply || null,
        });
      } catch (err: any) {
        send('error', { error: err.message, retryable: true });
      } finally {
        lease.release();
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}

export async function GET() {
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
    } catch {
      // continue with defaults
    }

    const conversationId = await ensureAskAiConversation(client, orgId, userId);
    const msgRes = await client.query(
      `SELECT id, role, content, tool_calls, created_at
       FROM messages
       WHERE org_id = $1 AND conversation_id = $2
       ORDER BY created_at ASC
       LIMIT 200`,
      [orgId, conversationId]
    );
    const planRes = await client.query(
      `SELECT * FROM agent_plans
       WHERE org_id = $1 AND user_id = $2 AND thread_id = 'ask-ai'
         AND status IN ('pending', 'approved', 'running', 'completed', 'completed_with_errors')
       ORDER BY created_at DESC
       LIMIT 20`,
      [orgId, userId]
    );

    return NextResponse.json({
      conversationId,
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
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
