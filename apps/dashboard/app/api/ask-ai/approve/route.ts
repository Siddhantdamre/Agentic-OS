import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { readJsonBody } from '@/lib/safe-json';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { canApproveActions, canApproveRefunds, canCallPayTools, isPayTool, loadHumanRole } from '@/lib/rbac';
import { mapTurnToResult, sanitizeAgentReply } from '@darex/workflows/dist/agent-client';
import { resumeTrueForgeTurn } from '@darex/workflows/dist/trueforge-client';
import { VALID_TOOLS } from '@/lib/plan-generator';
import { persistAskAiMessage } from '@/lib/ask-ai-persist';
import { startMemoryWriteBackWorkflow } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same allowlist as the Ask AI simple path: a resumed turn must never gain
// tools the original turn didn't have.
const RESUME_TOOL_ALLOWLIST = Array.from(
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

interface DecisionBody {
  threadId?: unknown;
  toolCallId?: unknown;
  tool?: unknown;
  action?: unknown;
  decision?: unknown;
  reason?: unknown;
}

/**
 * POST /api/ask-ai/approve — resume a TrueForge turn paused on
 * `tool.approval_required`.
 *
 * Body: { sessionId, decisions: [{ threadId, toolCallId, decision: 'allow'|'deny', reason? }] }
 * Streams NDJSON: chunk / tool / approval (chained pauses) / done / error.
 *
 * Tenancy: orgId/userId come ONLY from the session (getScopedClient). The
 * client-supplied sessionId is an opaque TrueForge UUID — tenant headers are
 * re-signed server-side, and the bridge re-verifies per tool call, so a
 * stolen sessionId authorizes nothing cross-tenant.
 */
export async function POST(request: Request) {
  let client: { release(): void } | null = null;
  try {
    const parsed = await readJsonBody<{
      sessionId?: unknown;
      decisions?: unknown;
      conversationId?: unknown;
      org_id?: unknown;
      orgId?: unknown;
    }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!UUID_RE.test(sessionId)) {
      return NextResponse.json({ error: 'sessionId must be a UUID' }, { status: 400 });
    }
    if (!Array.isArray(body.decisions) || body.decisions.length === 0 || body.decisions.length > 10) {
      return NextResponse.json({ error: 'decisions must be a non-empty array (max 10)' }, { status: 400 });
    }
    const decisions: { threadId: string; toolCallId: string; tool?: string; action?: string; decision: 'allow' | 'deny'; reason?: string }[] = [];
    for (const d of body.decisions as DecisionBody[]) {
      if (!d || typeof d !== 'object') {
        return NextResponse.json({ error: 'each decision needs threadId, toolCallId, decision' }, { status: 400 });
      }
      const threadId = typeof d.threadId === 'string' ? d.threadId : '';
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : '';
      if (!threadId || !toolCallId) {
        return NextResponse.json({ error: 'each decision needs threadId, toolCallId, decision' }, { status: 400 });
      }
      if (d.decision !== 'allow' && d.decision !== 'deny') {
        return NextResponse.json({ error: "decision must be 'allow' or 'deny'" }, { status: 400 });
      }
      decisions.push({
        threadId,
        toolCallId,
        tool: typeof d.tool === 'string' ? d.tool : undefined,
        action: typeof d.action === 'string' ? d.action : undefined,
        decision: d.decision,
        reason: typeof d.reason === 'string' ? d.reason.slice(0, 500) : undefined,
      });
    }
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';

    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    // SEC-R01: Verify human approver has permissions for action classes and pay tools
    const userRole = await loadHumanRole(client as any, userId);
    client.release();
    client = null;

    if (decisions.some((d) => d.decision === 'allow')) {
      if (!canApproveActions(userRole)) {
        return NextResponse.json(
          { error: `Forbidden: role "${userRole}" is not authorized to approve actions` },
          { status: 403 }
        );
      }

      const hasPayApproval = decisions.some((d) => {
        if (d.decision !== 'allow') return false;
        return isPayTool(d.tool || '', d.action);
      });
      if (hasPayApproval && !canCallPayTools(userRole)) {
        return NextResponse.json(
          { error: `Forbidden: role "${userRole}" is not authorized to approve payment actions` },
          { status: 403 }
        );
      }

      const hasRefundApproval = decisions.some((d) => {
        if (d.decision !== 'allow') return false;
        const combined = `${d.tool || ''} ${d.action || ''}`;
        return /refund/i.test(combined);
      });
      if (hasRefundApproval && !canApproveRefunds(userRole)) {
        return NextResponse.json(
          { error: `Forbidden: role "${userRole}" is not authorized to approve refund actions` },
          { status: 403 }
        );
      }
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (eventType: string, payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(JSON.stringify({ type: eventType, ...payload }) + '\n'));
        };
        try {
          const turn = await resumeTrueForgeTurn(
            { sessionId, orgId, userId, toolAllowlist: RESUME_TOOL_ALLOWLIST, decisions },
            {
              timeoutMs: 120000,
              onChunk: (text: string) => send('chunk', { text }),
              onToolProgress: (tool: string, label: string) => send('tool', { tool, label }),
              onSubagent: (ev) => send('subagent', { subagent: ev }),
            }
          );
          const result = mapTurnToResult(turn);
          const answer = sanitizeAgentReply(result.replyMessage);
          await logLangfuseTrace({
            name: 'AskAI-ApprovalResume',
            orgId,
            input: { sessionId, decisions: decisions.map((d) => ({ toolCallId: d.toolCallId, decision: d.decision })) },
            output: answer,
            metadata: { usedTools: result.usedTools, steps: result.executedSteps.length },
          }).catch(console.error);

          if (conversationId) {
            try {
              await persistAskAiMessage(orgId, conversationId, 'assistant', answer, {
                type: 'simple',
                resumed: true,
                usedTools: result.usedTools,
                executedSteps: result.executedSteps,
                trajectory: result.executedSteps.map((s: any) => ({
                  step: s.step,
                  thought: s.action,
                  action: s.toolUsed || 'reason',
                  observation: s.result,
                })),
                error: (result as { error?: string }).error || null,
                retryable: result.retryable || false,
              });
            } catch (err: any) {
              console.warn('[Ask AI Approve] Failed to persist assistant message:', err?.message);
            }
            if (result.success && answer) {
              void startMemoryWriteBackWorkflow({
                orgId,
                conversationId,
                closed: false,
                toolResults: result.executedSteps,
                businessKey: `ask-ai-approve:${conversationId}:${Date.now()}`,
              });
            }
          }

          if (result.approvals && result.approvals.length > 0 && result.sessionId) {
            send('approval', { conversationId, sessionId: result.sessionId, approvals: result.approvals });
          }
          send('done', {
            conversationId,
            answer,
            provider: 'TrueForge',
            usedTools: result.usedTools,
            executedSteps: result.executedSteps,
            sessionId: result.sessionId || null,
            approvals: result.approvals || [],
            subagents: result.subagents || [],
            usage: result.usage || null,
            error: (result as { error?: string }).error || null,
            retryable: result.retryable || false,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Resume failed';
          send('error', { error: message, retryable: true });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  } catch (error: unknown) {
    if (client) client.release();
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/ask-ai/approve Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
