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

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const authHeader = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 5000);

    // Langfuse v3 ingestion schema: `timestamp` is an EVENT-level field (ISO
    // string), NOT inside `body`. Sending it in body makes the ingestion API
    // reject the batch with 400, so traces silently never appear.
    const body = {
      batch: [
        {
          id: `trace-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          type: 'trace-create',
          timestamp: new Date().toISOString(),
          body: {
            name: params.name,
            userId: params.orgId,
            input: params.input,
            output: params.output,
            metadata: {
              ...params.metadata,
              provider: params.provider || 'unknown',
            },
          },
        },
      ],
    };

    const res = await fetch(`${langfuseHost}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[Langfuse] Ingestion HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return;
    }
    const ingest = await res.json().catch(() => null);
    const failed = ingest?.errors?.length ? ingest.errors : [];
    if (failed.length > 0) {
      console.warn(`[Langfuse] Ingestion rejected ${failed.length} event(s):`, JSON.stringify(failed).slice(0, 400));
    }
  } catch (err: any) {
    // Observability must never crash the request, but we surface it now so a
    // misconfigured instance is visible in logs instead of silently dropping.
    console.warn('[Langfuse Trace Error]:', err?.message);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
