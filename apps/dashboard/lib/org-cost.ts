/**
 * Org-scoped LLM cost + action aggregates from the Langfuse public API.
 * Never guesses cost: if Langfuse is down or unconfigured, throw instead of
 * returning a fabricated $0 "verified" total.
 */

import type { PoolClient } from 'pg';
import {
  isDisconnectedToolPayload,
  langfuseBasicAuth,
  LangfuseConfigError,
  resolveLangfuseConfig,
} from '@/lib/langfuse-trace';

export const WEEK_DAYS = 7;
export const CONFIRM_REJECT_HIGH_THRESHOLD = 0.3;
export const CONFIRM_REJECT_MIN_SAMPLE = 5;
const FETCH_TIMEOUT_MS = 10000;
const TRACE_PAGE_SIZE = 100;
const MAX_TRACE_PAGES = 20;

export class LangfuseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LangfuseUnavailableError';
  }
}

export type ConfirmRejectDrift = {
  confirmed: number;
  rejected: number;
  pending: number;
  sampleSize: number;
  rejectRate: number | null;
  highRejectFlag: boolean;
  threshold: number;
  minSample: number;
};

export type OrgCostDay = {
  date: string;
  costUsd: number;
  traces: number;
};

export type OrgWeeklyCost = {
  orgId: string;
  period: { from: string; to: string; days: number };
  weeklyCostUsd: number;
  source: 'langfuse';
  verified: true;
  truncated: boolean;
  traceCount: number;
  successfulActions: number;
  disconnectedActions: number;
  byDay: OrgCostDay[];
};

type ActionClass = 'successful' | 'disconnected' | 'other';

type LangfuseTrace = {
  id?: string;
  name?: string;
  userId?: string | null;
  timestamp?: string;
  tags?: string[];
  metadata?: unknown;
  output?: unknown;
  totalCost?: number | string | null;
  calculatedTotalCost?: number | string | null;
};

type LangfuseListResponse<T> = {
  data?: T[];
  meta?: { page?: number; limit?: number; totalItems?: number; totalPages?: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function weekWindow(now = new Date()): { from: Date; to: Date } {
  const to = now;
  const from = new Date(to.getTime() - WEEK_DAYS * 24 * 60 * 60 * 1000);
  return { from, to };
}

function dateKey(iso: string | undefined, fallback: Date): string {
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return fallback.toISOString().slice(0, 10);
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function traceOrgId(trace: LangfuseTrace): string | null {
  if (typeof trace.userId === 'string' && trace.userId) return trace.userId;
  if (isRecord(trace.metadata) && typeof trace.metadata.orgId === 'string') {
    return trace.metadata.orgId;
  }
  return null;
}

function belongsToOrg(trace: LangfuseTrace, orgId: string): boolean {
  const owner = traceOrgId(trace);
  if (owner) return owner === orgId;
  const tags = Array.isArray(trace.tags) ? trace.tags : [];
  return tags.includes(`org:${orgId}`);
}

function isNonActionTrace(name: string): boolean {
  return name === 'PlanGenerated' || name === 'PlanExecutionSummary';
}

function classifyTraceAction(trace: LangfuseTrace): ActionClass {
  const tags = Array.isArray(trace.tags) ? trace.tags : [];
  const metadata = isRecord(trace.metadata) ? trace.metadata : {};
  const output = parseJsonish(trace.output);

  if (
    tags.includes('notConnected') ||
    metadata.disconnected === true ||
    metadata.successfulAction === false ||
    isDisconnectedToolPayload(output) ||
    isDisconnectedToolPayload(metadata)
  ) {
    return 'disconnected';
  }

  const name = typeof trace.name === 'string' ? trace.name : '';
  if (isNonActionTrace(name)) return 'other';

  if (metadata.successfulAction === true) return 'successful';
  if (tags.includes('successfulAction')) return 'successful';
  if (isRecord(output) && output.status === 'executed') return 'successful';
  return 'other';
}

function classifyAction(value: ActionClass): ActionClass {
  switch (value) {
    case 'successful':
    case 'disconnected':
    case 'other':
      return value;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

async function langfuseGet(
  path: string,
  search: URLSearchParams,
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<{ status: number; body: string }> {
  const config = resolveLangfuseConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs = search.toString();
    const url = qs ? `${config.host}${path}?${qs}` : `${config.host}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: langfuseBasicAuth(config.publicKey, config.secretKey),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    return { status: res.status, body };
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Langfuse request timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new LangfuseUnavailableError(message);
  } finally {
    clearTimeout(timeout);
  }
}

function parseList<T>(body: string): LangfuseListResponse<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new LangfuseUnavailableError('Langfuse returned non-JSON');
  }
  if (Array.isArray(parsed)) {
    return { data: parsed as T[], meta: { totalPages: 1 } };
  }
  if (isRecord(parsed)) {
    return parsed as LangfuseListResponse<T>;
  }
  throw new LangfuseUnavailableError('Langfuse returned an unexpected payload');
}

async function fetchTracesForOrg(
  orgId: string,
  from: Date,
  to: Date
): Promise<{ traces: LangfuseTrace[]; truncated: boolean }> {
  const traces: LangfuseTrace[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_TRACE_PAGES; page++) {
    const search = new URLSearchParams({
      userId: orgId,
      fromTimestamp: from.toISOString(),
      toTimestamp: to.toISOString(),
      limit: String(TRACE_PAGE_SIZE),
      page: String(page),
    });
    const { status, body } = await langfuseGet('/api/public/traces', search);
    if (status === 401 || status === 403) {
      throw new LangfuseUnavailableError(`Langfuse auth failed (HTTP ${status})`);
    }
    if (status >= 500 || status === 0) {
      throw new LangfuseUnavailableError(`Langfuse traces HTTP ${status}: ${body.slice(0, 200)}`);
    }
    if (status === 404) {
      throw new LangfuseUnavailableError(
        'Langfuse traces API not found — ClickHouse persistence may be down'
      );
    }
    if (status !== 200) {
      throw new LangfuseUnavailableError(`Langfuse traces HTTP ${status}: ${body.slice(0, 200)}`);
    }

    const parsed = parseList<LangfuseTrace>(body);
    const pageRows = Array.isArray(parsed.data) ? parsed.data : [];
    for (const row of pageRows) {
      if (belongsToOrg(row, orgId)) traces.push(row);
    }

    const totalPages = parsed.meta?.totalPages ?? 1;
    if (page >= totalPages || pageRows.length === 0) break;
    if (page === MAX_TRACE_PAGES && page < totalPages) truncated = true;
  }

  return { traces, truncated };
}

function emptyDays(from: Date, to: Date): OrgCostDay[] {
  const days: OrgCostDay[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    days.push({ date: cursor.toISOString().slice(0, 10), costUsd: 0, traces: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Weekly LLM cost for one org, read from Langfuse (userId = orgId).
 * Throws LangfuseUnavailableError / LangfuseConfigError — never a fake $0 success.
 */
export async function fetchOrgWeeklyCost(orgId: string, now = new Date()): Promise<OrgWeeklyCost> {
  if (!orgId) {
    throw new LangfuseUnavailableError('orgId is required');
  }

  try {
    resolveLangfuseConfig();
  } catch (err) {
    if (err instanceof LangfuseConfigError) {
      throw new LangfuseUnavailableError(err.message);
    }
    throw err;
  }

  const { from, to } = weekWindow(now);
  // Traces are filtered by userId=orgId at the API and again client-side so
  // org A cannot see org B even if Langfuse ignores a query param.
  const { traces, truncated } = await fetchTracesForOrg(orgId, from, to);

  const byDayMap = new Map<string, OrgCostDay>();
  for (const seed of emptyDays(from, to)) {
    byDayMap.set(seed.date, seed);
  }

  let successfulActions = 0;
  let disconnectedActions = 0;
  let traceCostTotal = 0;

  for (const trace of traces) {
    const day = dateKey(trace.timestamp, from);
    const bucket = byDayMap.get(day) || { date: day, costUsd: 0, traces: 0 };
    bucket.traces += 1;
    const cost = asNumber(trace.totalCost ?? trace.calculatedTotalCost);
    bucket.costUsd += cost;
    traceCostTotal += cost;
    byDayMap.set(day, bucket);

    const action = classifyAction(classifyTraceAction(trace));
    switch (action) {
      case 'successful':
        successfulActions += 1;
        break;
      case 'disconnected':
        disconnectedActions += 1;
        break;
      case 'other':
        break;
      default: {
        const exhaustive: never = action;
        void exhaustive;
        break;
      }
    }
  }

  const byDay = Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const weeklyCostUsd = traceCostTotal;

  return {
    orgId,
    period: { from: from.toISOString(), to: to.toISOString(), days: WEEK_DAYS },
    weeklyCostUsd: Number(weeklyCostUsd.toFixed(6)),
    source: 'langfuse',
    verified: true,
    truncated,
    traceCount: traces.length,
    successfulActions,
    disconnectedActions,
    byDay: byDay.map((d) => ({
      ...d,
      costUsd: Number(d.costUsd.toFixed(6)),
    })),
  };
}

export async function queryConfirmRejectDrift(
  client: PoolClient,
  orgId: string,
  from: Date
): Promise<ConfirmRejectDrift> {
  const res = await client.query<{ confirmed: number; rejected: number; pending: number }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status IN ('approved', 'running', 'completed', 'completed_with_errors')
       )::int AS confirmed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS rejected,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
     FROM agent_plans
     WHERE org_id = $1 AND created_at >= $2`,
    [orgId, from.toISOString()]
  );
  const row = res.rows[0] || { confirmed: 0, rejected: 0, pending: 0 };
  const confirmed = Number(row.confirmed) || 0;
  const rejected = Number(row.rejected) || 0;
  const pending = Number(row.pending) || 0;
  const sampleSize = confirmed + rejected;
  const rejectRate = sampleSize > 0 ? rejected / sampleSize : null;
  const highRejectFlag =
    sampleSize >= CONFIRM_REJECT_MIN_SAMPLE &&
    rejectRate !== null &&
    rejectRate >= CONFIRM_REJECT_HIGH_THRESHOLD;

  return {
    confirmed,
    rejected,
    pending,
    sampleSize,
    rejectRate,
    highRejectFlag,
    threshold: CONFIRM_REJECT_HIGH_THRESHOLD,
    minSample: CONFIRM_REJECT_MIN_SAMPLE,
  };
}
