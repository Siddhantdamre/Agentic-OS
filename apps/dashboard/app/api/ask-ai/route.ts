import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { logLangfuseTrace } from '@/lib/langfuse-trace';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
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
    } finally {
      client.release();
    }

    const { prompt } = await request.json();
    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    // Run the atomic-agent loop with real tool dispatch (MCP + memory fabric)
    const { runAutonomousAgentDirect } = await import('@darex/workflows/dist/atomic-agent-client');

    const result = await runAutonomousAgentDirect(
      {
        orgId,
        employeeName: 'DareX Executive',
        employeeRole: 'Primary Business Assistant',
        employeePersona: `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. Connected channels: ${connectedChannelsList.join(', ') || 'none'}. Act decisively and execute tools when needed.`,
        toolAllowlist: [
          'gmail', 'google-calendar', 'github', 'whatsapp', 'hubspot',
          'meta-ads', 'google-ads', 'slack', 'notion', 'stripe',
          'shopify', 'zendesk', 'intercom', 'razorpay',
          'database_query', 'web_search', 'web_extract', 'file_ops',
        ],
        userMessage: prompt,
      }
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
      answer: result.replyMessage,
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
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/ask-ai Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
