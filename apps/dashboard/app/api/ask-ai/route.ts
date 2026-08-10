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

    // Dynamically import to avoid circular deps at module load time
    const { runAutonomousAgentLoop } = await import('@darex/workflows/dist/agent-engine');
    const { executeAutonomousToolAction } = await import('@darex/workflows/dist/tool-executor');

    // Run the full autonomous agent loop with REAL tool dispatch
    const result = await runAutonomousAgentLoop(
      {
        orgId,
        employeeName: 'DareX Executive',
        employeeRole: 'Primary Business Assistant',
        employeePersona: `You are DareX Executive, an autonomous AI assistant for ${orgName}. Current user: ${currentUserEmail}. Connected channels: ${connectedChannelsList.join(', ') || 'none'}. Act decisively and execute tools when needed.`,
        toolAllowlist: [
          'gmail', 'google-calendar', 'github', 'whatsapp', 'hubspot',
          'meta-ads', 'google-ads', 'slack', 'notion', 'stripe',
          'shopify', 'zendesk', 'intercom', 'razorpay',
          'sandbox', 'hermes_python_sandbox', 'code_execution',
        ],
        userMessage: prompt,
      },
      async (tool: string, action: string, payload: any) => {
        const res = await executeAutonomousToolAction({ tool, action, payload, orgId });
        return { status: res.status, data: res.data };
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
      provider: 'Hermes Autonomous Engine',
      toolsAvailable: 15,
      usedTools: result.usedTools,
      executedSteps: result.executedSteps,
      hermesTrajectory: result.executedSteps.map((s, i) => ({
        step: s.step,
        thought: s.action,
        action: s.toolUsed || 'reason',
        observation: s.result,
      })),
      learnedSkills: result.usedTools.map(t => `Executed: ${t}`),
      activeHermesTools: result.usedTools,
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
