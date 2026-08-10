/**
 * Langfuse Tracing Helper for LLM Observability
 * Connects to local Langfuse Docker service (http://localhost:3002)
 */

interface TraceParams {
  name: string;
  orgId: string;
  input: any;
  output: any;
  metadata?: Record<string, any>;
  provider?: string;
}

export async function logLangfuseTrace(params: TraceParams): Promise<void> {
  const langfuseHost = process.env.LANGFUSE_HOST || 'http://localhost:3002';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || process.env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_INIT_PROJECT_SECRET_KEY;

  if (!publicKey || !secretKey) {
    console.debug('[Langfuse] No API keys configured — skipping trace');
    return;
  }

  try {
    const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const body = {
      batch: [
        {
          id: `trace-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          type: 'trace-create',
          body: {
            name: params.name,
            userId: params.orgId,
            input: params.input,
            output: params.output,
            metadata: {
              ...params.metadata,
              provider: params.provider || 'unknown',
              timestamp: new Date().toISOString(),
            },
          },
        },
      ],
    };

    await fetch(`${langfuseHost}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).catch(() => {});

    clearTimeout(timeout);
  } catch (err: any) {
    // Non-blocking observability logger
    console.debug('[Langfuse Trace Log Non-blocking error]:', err?.message);
  }
}
