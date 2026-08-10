import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { HermesAgentAdapter } from '@/lib/hermes-agent';
import { logLangfuseTrace } from '@/lib/langfuse-trace';

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    client.release();

    const body = await request.json();
    const { prompt, provider, mode } = body;

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const adapter = new HermesAgentAdapter(orgId, userId);
    const result = await adapter.executeTask({
      prompt,
      provider: provider || 'groq',
      mode: mode || 'reason',
    });

    // Send LLM trace to Langfuse observability container
    await logLangfuseTrace({
      name: 'HermesAgentExecution',
      orgId,
      input: { prompt, mode },
      output: result.finalResponse,
      provider: result.provider,
      metadata: { trajectorySteps: result.reasoningTrajectory.length },
    });

    return NextResponse.json({
      success: true,
      agent: 'NousResearch-Hermes-Agent-v3',
      result,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/hermes Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
