/**
 * Langfuse tracing helper for LLM observability.
 * Ingests via POST /api/public/ingestion (Langfuse v3 event-level timestamp).
 * Errors are never swallowed: production fails fast on missing keys; ingest
 * failures throw after being logged so misconfig is visible.
 */

export interface TraceUsage {
  input?: number;
  output?: number;
  total?: number;
  unit?: 'TOKENS' | 'CHARACTERS' | 'MILLISECONDS' | 'SECONDS' | 'IMAGES';
}

export interface TraceParams {
  name: string;
  orgId: string;
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown>;
  provider?: string;
  model?: string;
  usage?: TraceUsage;
  level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
}

export type LangfuseConfig = {
  host: string;
  publicKey: string;
  secretKey: string;
};

export class LangfuseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LangfuseConfigError';
  }
}

export class LangfuseIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LangfuseIngestError';
  }
}

const NOT_CONNECTED_RE = /not[\s_-]*connected|notConnected/i;
const INGEST_TIMEOUT_MS = 5000;

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a tool result is a disconnected / notConnected payload.
 * These must never be tagged or counted as successful actions.
 */
export function isDisconnectedToolPayload(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (typeof value === 'boolean') return false;
  if (typeof value === 'string') return NOT_CONNECTED_RE.test(value);
  if (Array.isArray(value)) {
    return value.some((entry) => isDisconnectedToolPayload(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  if (value.connected === false) return true;
  if (isRecord(value.data) && value.data.connected === false) return true;
  if (typeof value.message === 'string' && NOT_CONNECTED_RE.test(value.message)) return true;
  if (typeof value.status === 'string' && value.status === 'error') {
    if (isDisconnectedToolPayload(value.data, depth + 1)) return true;
    if (typeof value.message === 'string' && NOT_CONNECTED_RE.test(value.message)) return true;
  }
  return (
    isDisconnectedToolPayload(value.data, depth + 1) ||
    isDisconnectedToolPayload(value.output, depth + 1) ||
    isDisconnectedToolPayload(value.results, depth + 1) ||
    isDisconnectedToolPayload(value.executedSteps, depth + 1) ||
    isDisconnectedToolPayload(value.metadata, depth + 1)
  );
}

function isExecutedSuccess(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return output.status === 'executed';
}

export function langfuseBasicAuth(publicKey: string, secretKey: string): string {
  return 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
}

/**
 * Env-driven Langfuse connection. Production fails fast when host or keys
 * are missing — no silent skip and no hardcoded prod URLs.
 */
export function resolveLangfuseConfig(): LangfuseConfig {
  const hostRaw = process.env.LANGFUSE_HOST || (isProd() ? '' : 'http://localhost:3002');
  const publicKey =
    process.env.LANGFUSE_PUBLIC_KEY || process.env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY || '';
  const secretKey =
    process.env.LANGFUSE_SECRET_KEY || process.env.LANGFUSE_INIT_PROJECT_SECRET_KEY || '';
  const host = hostRaw.replace(/\/$/, '');

  if (isProd() && (!host || !publicKey || !secretKey)) {
    throw new LangfuseConfigError(
      'LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY must be set in production'
    );
  }
  if (!host || !publicKey || !secretKey) {
    throw new LangfuseConfigError(
      'Langfuse is not configured (LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)'
    );
  }
  return { host, publicKey, secretKey };
}

function tryResolveLangfuseConfig(): LangfuseConfig | null {
  try {
    return resolveLangfuseConfig();
  } catch (err) {
    if (!isProd() && err instanceof LangfuseConfigError) {
      console.error('[Langfuse]', err.message, '— skipping ingest');
      return null;
    }
    throw err;
  }
}

type IngestEvent = {
  id: string;
  type: 'trace-create' | 'generation-create';
  timestamp: string;
  body: Record<string, unknown>;
};

function buildIngestBatch(params: TraceParams): { traceId: string; batch: IngestEvent[] } {
  const timestamp = new Date().toISOString();
  const traceId = crypto.randomUUID();
  const disconnected =
    isDisconnectedToolPayload(params.output) || isDisconnectedToolPayload(params.metadata);
  const successfulAction = !disconnected && isExecutedSuccess(params.output);
  const level = params.level || (disconnected ? 'WARNING' : 'DEFAULT');
  const tags = ['darex', `org:${params.orgId}`];
  if (disconnected) tags.push('notConnected');
  if (successfulAction) tags.push('successfulAction');

  const metadata: Record<string, unknown> = {
    ...params.metadata,
    orgId: params.orgId,
    provider: params.provider || 'unknown',
    successfulAction,
    disconnected,
  };

  const batch: IngestEvent[] = [
    {
      id: crypto.randomUUID(),
      type: 'trace-create',
      timestamp,
      body: {
        id: traceId,
        name: params.name,
        userId: params.orgId,
        input: params.input,
        output: params.output,
        metadata,
        tags,
        environment: process.env.NODE_ENV || 'development',
      },
    },
  ];

  if (params.usage || params.model) {
    const usage = params.usage
      ? {
          input: params.usage.input,
          output: params.usage.output,
          total: params.usage.total,
          unit: params.usage.unit || 'TOKENS',
        }
      : undefined;
    batch.push({
      id: crypto.randomUUID(),
      type: 'generation-create',
      timestamp,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: params.name,
        startTime: timestamp,
        endTime: timestamp,
        model: params.model || params.provider || 'unknown',
        input: params.input,
        output: params.output,
        metadata,
        level,
        ...(usage ? { usage } : {}),
      },
    });
  }

  return { traceId, batch };
}

export async function logLangfuseTrace(params: TraceParams): Promise<void> {
  const config = tryResolveLangfuseConfig();
  if (!config) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const authHeader = langfuseBasicAuth(config.publicKey, config.secretKey);
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    // Langfuse v3 ingestion schema: `timestamp` is an EVENT-level field (ISO
    // string), NOT inside `body`. Sending it in body makes the ingestion API
    // reject the batch with 400, so traces silently never appear.
    const { batch } = buildIngestBatch(params);
    const res = await fetch(`${config.host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ batch }),
      signal: controller.signal,
    });

    const errBody = await res.text().catch(() => '');
    if (res.status !== 201 && res.status !== 200) {
      throw new LangfuseIngestError(
        `Ingestion HTTP ${res.status}: ${errBody.slice(0, 300)}`
      );
    }

    let ingest: { errors?: unknown[] } | null = null;
    if (errBody) {
      try {
        ingest = JSON.parse(errBody) as { errors?: unknown[] };
      } catch {
        ingest = null;
      }
    }
    const failed = Array.isArray(ingest?.errors) ? ingest.errors : [];
    if (failed.length > 0) {
      throw new LangfuseIngestError(
        `Ingestion rejected ${failed.length} event(s): ${JSON.stringify(failed).slice(0, 400)}`
      );
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Ingestion timed out after ${INGEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error('[Langfuse Trace Error]:', message);
    if (err instanceof LangfuseIngestError) throw err;
    throw new LangfuseIngestError(message);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
