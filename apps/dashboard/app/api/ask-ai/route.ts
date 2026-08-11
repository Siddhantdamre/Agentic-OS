import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';
import { sanitizeAgentReply } from '@darex/workflows/dist/atomic-agent-client';
import type { PoolClient } from 'pg';

export const dynamic = 'force-dynamic';

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
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const orgId = scoped.orgId;
    const userId = scoped.userId;
    let orgName = 'Your Business';
    let currentUserEmail = 'user@company.com';
    let connectedChannelsList: string[] = [];
    let employeeNames: string[] = [];

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

      const empRes = await client.query('SELECT name, role FROM ai_employees WHERE org_id = $1', [orgId]);
      employeeNames = empRes.rows.map((r: any) => `${r.name} (${r.role})`);
    } catch {
      // Continue if context queries fail
    }

    const { prompt } = await request.json();
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // Classify: SIMPLE (answer inline) vs COMPLEX (propose an approvable plan)
    const { classifyRequest } = await import('@/lib/classify');
    const classification = await classifyRequest(String(prompt), orgId);

    // ── COMPLEX: generate plan + draft, persist, present for approval ──────
    if (classification.type === 'complex') {
      const { generatePlan } = await import('@/lib/plan-generator');
      try {
        const generated = await generatePlan(String(prompt), orgId, connectedChannelsList);

        const planId = crypto.randomUUID();
        await client2InsertPlan(client, planId, orgId, userId, generated, classification);

        return NextResponse.json({
          type: 'complex',
          classification: { confidence: classification.confidence, usedFallback: classification.usedFallback },
          planId,
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
        // Planner failed — degrade gracefully to a normal inline agent answer.
        console.error('Plan generation failed, falling back to direct answer:', planErr.message);
        const { runAutonomousAgentDirect } = await import('@darex/workflows/dist/atomic-agent-client');
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        // Fresh session per request: a reusable session accumulates unbounded
        // context that makes every subsequent turn hang and time out.
        const sessionKey = `askai-${userId}-${day}-${crypto.randomUUID().slice(0, 8)}`;
        const result = await runAutonomousAgentDirect(
          {
            orgId,
            sessionKey,
            employeeName: 'DareX Executive',
            employeeRole: 'Primary Business Assistant',
            employeePersona: `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. Connected channels: ${connectedChannelsList.join(', ') || 'none'}. Act decisively and execute tools when needed. Your org_id is ${orgId} — always pass it to mcp.darex.database_query and mcp.darex.database_execute, and never search memory to find it.`,
            toolAllowlist: [
              'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets',
              'github', 'whatsapp', 'hubspot',
              'meta-ads', 'google-ads', 'slack', 'notion', 'stripe',
              'shopify', 'zendesk', 'intercom', 'razorpay',
              'database_query', 'web_search', 'web_extract', 'file_ops',
            ],
            userMessage: prompt,
          },
          { timeoutMs: 120000 }
        );
        await logLangfuseTrace({
          name: 'AskAI-PlanFallback',
          orgId,
          input: { prompt, reason: planErr.message },
          output: result.replyMessage,
          metadata: { usedTools: result.usedTools },
        });
        return NextResponse.json({
          type: 'simple',
          answer: sanitizeAgentReply(result.replyMessage),
          provider: 'Atomic Agent',
          usedTools: result.usedTools,
          executedSteps: result.executedSteps,
          proposedAction: null,
          error: result.error || null,
          retryable: result.retryable || false,
          partialReply: result.partialReply || null,
        });
      }
    }

    // ── SIMPLE: run the atomic-agent loop with real tool dispatch ──────────
    const { runAutonomousAgentDirect } = await import('@darex/workflows/dist/atomic-agent-client');

    // Scope + rotate the atomic-agent session per request so a long-lived or
    // looping session can never poison Ask AI — each Ask AI prompt is
    // self-contained, and a shared session accumulates context that eventually
    // makes every turn hang and time out.
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const sessionKey = `askai-${userId}-${day}-${crypto.randomUUID().slice(0, 8)}`;

    const result = await runAutonomousAgentDirect(
      {
        orgId,
        sessionKey,
        employeeName: 'DareX Executive',
        employeeRole: 'Primary Business Assistant',
        employeePersona: `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. Connected channels: ${connectedChannelsList.join(', ') || 'none'}. Act decisively and execute tools when needed. Your org_id is ${orgId} — always pass it to mcp.darex.database_query and mcp.darex.database_execute, and never search memory to find it.`,
        toolAllowlist: [
          'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets',
          'github', 'whatsapp', 'hubspot',
          'meta-ads', 'google-ads', 'slack', 'notion', 'stripe',
          'shopify', 'zendesk', 'intercom', 'razorpay',
          'database_query', 'web_search', 'web_extract', 'file_ops',
        ],
        userMessage: prompt,
      },
      { timeoutMs: 120000 }
    );

    // Log to Langfuse
    await logLangfuseTrace({
      name: 'AskAI-AutonomousExecution',
      orgId,
      input: { prompt },
      output: result.replyMessage,
      metadata: { usedTools: result.usedTools, steps: result.executedSteps.length },
    });

    return NextResponse.json({
      type: 'simple',
      answer: sanitizeAgentReply(result.replyMessage),
      provider: 'Atomic Agent',
      usedTools: result.usedTools,
      executedSteps: result.executedSteps,
      trajectory: result.executedSteps.map((s, i) => ({
        step: s.step,
        thought: s.action,
        action: s.toolUsed || 'reason',
        observation: s.result,
      })),
      proposedAction: null,
      // Failure diagnostics (UI renders an amber banner + Retry when present)
      error: result.error || null,
      retryable: result.retryable || false,
      partialReply: result.partialReply || null,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
