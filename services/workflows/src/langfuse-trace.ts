/**
 * Langfuse traces for agent turns the worker runs (OPS-B03): inbound
 * channels, crews and sweeps. Dashboard routes trace their own turns
 * (apps/dashboard/lib/langfuse-trace.ts); this is the same ingestion format,
 * POST /api/public/ingestion with a trace and, when known, a generation.
 * Never blocks or fails a turn: callers fire and forget, and a missing config
 * or a rejected batch is logged.
 */
import { randomUUID } from 'node:crypto';
import type { TurnUsage } from '@darex/shared-types';

const INGEST_TIMEOUT_MS = 5000;

export interface WorkerTraceParams {
  name: string;
  orgId: string;
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  usage?: TurnUsage;
  level?: 'DEFAULT' | 'WARNING' | 'ERROR';
}

type LangfuseConfig = { host: string; publicKey: string; secretKey: string };

export function workerLangfuseConfig(env: NodeJS.ProcessEnv = process.env): LangfuseConfig | null {
  const host = (env.LANGFUSE_HOST || '').replace(/\/$/, '');
  const publicKey = env.LANGFUSE_PUBLIC_KEY || env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY || '';
  const secretKey = env.LANGFUSE_SECRET_KEY || env.LANGFUSE_INIT_PROJECT_SECRET_KEY || '';
  return host && publicKey && secretKey ? { host, publicKey, secretKey } : null;
}

/** Ingestion batch: `timestamp` is event-level, not in `body` (Langfuse v3 rejects it there). */
export function buildWorkerTraceBatch(params: WorkerTraceParams, now = new Date()): Array<Record<string, unknown>> {
  const timestamp = now.toISOString();
  const traceId = randomUUID();
  const metadata = { ...params.metadata, orgId: params.orgId, runtime: 'worker' };
  const batch: Array<Record<string, unknown>> = [
    {
      id: randomUUID(),
      type: 'trace-create',
      timestamp,
      body: {
        id: traceId,
        name: params.name,
        userId: params.orgId,
        input: params.input,
        output: params.output,
        metadata,
        tags: ['darex', 'worker', `org:${params.orgId}`],
        environment: process.env.NODE_ENV || 'development',
      },
    },
  ];
  const usage = params.usage;
  if (usage || params.model) {
    const cost = usage?.totalCostInUsd;
    batch.push({
      id: randomUUID(),
      type: 'generation-create',
      timestamp,
      body: {
        id: randomUUID(),
        traceId,
        name: params.name,
        startTime: new Date(now.getTime() - Math.max(0, usage?.durationMs ?? 0)).toISOString(),
        endTime: timestamp,
        model: params.model || 'unknown',
        input: params.input,
        output: params.output,
        metadata,
        level: params.level || 'DEFAULT',
        ...(usage
          ? { usage: { input: usage.inputTokens, output: usage.outputTokens, total: usage.totalTokens, unit: 'TOKENS' } }
          : {}),
        ...(cost != null && Number.isFinite(cost) && cost > 0 ? { costDetails: { total: cost } } : {}),
      },
    });
  }
  return batch;
}

let warnedUnconfigured = false;

export async function logWorkerTurnTrace(params: WorkerTraceParams): Promise<void> {
  const config = workerLangfuseConfig();
  if (!config) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn('[Langfuse] LANGFUSE_HOST / keys not set on the worker; worker turns are not traced');
    }
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.host}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64'),
      },
      body: JSON.stringify({ batch: buildWorkerTraceBatch(params) }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let rejected = 0;
    try {
      const parsed = text ? (JSON.parse(text) as { errors?: unknown[] }) : null;
      rejected = Array.isArray(parsed?.errors) ? parsed.errors.length : 0;
    } catch {
      rejected = 0;
    }
    if (![200, 201, 207].includes(res.status) || rejected > 0) {
      console.error(`[Langfuse] worker trace not ingested (HTTP ${res.status}, ${rejected} rejected): ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('[Langfuse] worker trace failed:', err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timeout);
  }
}
