import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, PoolClient } from 'pg';
import { connectorSignInPath, type ToolExecutionResult } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import { confirmForRisk } from './risk.js';

export const NANGO_HOST = process.env.NANGO_HOST || 'http://localhost:3003';
export const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY; // Must be set — no insecure fallback

function parseTimeoutEnv(name: string, fallbackMs: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

export const NANGO_TIMEOUT_MS = parseTimeoutEnv('NANGO_TIMEOUT_MS', 10_000);
/** Executor deadline for one tool call (tool-executor re-exports this). */
export const TOOL_EXECUTION_TIMEOUT_MS = parseTimeoutEnv('TOOL_EXECUTION_TIMEOUT_MS', 15_000);
/**
 * Per-request provider HTTP deadline. Never longer than the executor
 * deadline: a request that outlives the executor can commit after the model
 * was told the call failed, and the model then retries it (RT-B04).
 */
export const TOOL_HTTP_TIMEOUT_MS = Math.min(
  parseTimeoutEnv('TOOL_HTTP_TIMEOUT_MS', 12_000),
  TOOL_EXECUTION_TIMEOUT_MS,
);

/**
 * Ambient abort signal for the tool call in flight. `executeProvider` runs a
 * module inside this scope with the executor's signal, and `fetchWithTimeout`
 * honors it, so provider requests stop when the executor gives up.
 */
const toolCallScope = new AsyncLocalStorage<{ signal: AbortSignal }>();

export function runWithToolSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? toolCallScope.run({ signal }, fn) : fn();
}

export function currentToolSignal(): AbortSignal | undefined {
  return toolCallScope.getStore()?.signal;
}

const runtimeDbUser = process.env.DB_USER || 'darex_app';
const runtimeDbPassword =
  runtimeDbUser === 'darex_app'
    ? (process.env.APP_DB_PASSWORD || process.env.DB_PASSWORD || 'darex_app_dev_secret')
    : (process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'darex_app_dev_secret');

export const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: runtimeDbUser,
  password: runtimeDbPassword,
  database: process.env.DB_NAME || 'darex',
  max: 10,
});

/**
 * Session-level RLS (is_local=false). Transaction-local set_config dies at
 * autocommit, so the next query on darex_app would run with no org GUC.
 * Refuses suspended / soft_deleted orgs so tools cannot keep spending.
 */
export async function withOrgScopedClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    const statusRes = await client.query<{ status: string }>(
      `SELECT status FROM orgs WHERE id = $1 LIMIT 1`,
      [orgId]
    );
    const status = (statusRes.rows[0]?.status || 'active').trim().toLowerCase();
    if (status === 'soft_deleted') {
      throw new Error('Workspace has been deleted');
    }
    if (status === 'suspended') {
      throw new Error('Workspace suspended');
    }
    return await fn(client);
  } finally {
    if ((client as any)._rollbackFailed) {
      // Connection's transaction state is unknown; destroy it instead of returning it to the pool.
      client.release(new Error('rollback failed, discarding connection'));
    } else {
      try {
        await client.query('RESET app.current_org_id');
      } catch {
        // always release the pool slot
      }
      client.release();
    }
  }
}

export interface ToolActionContext {
  tool: string;
  action: string;
  actionName: string;
  payload: Record<string, any>;
  orgId: string;
  timestamp: string;
  /** Aborted when the executor deadline passes; fetchWithTimeout honors it. */
  signal?: AbortSignal;
  /**
   * Stable across retries of the same call (RT-B10); set only when the call
   * has a durable anchor (workflow id or approved action). Providers that
   * support it send it so a retried write is not applied twice.
   */
  idempotencyKey?: string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Provider idempotency key for one tool call, or undefined when nothing makes
 * a retry recognisable (a chat turn is not retried; see RT-B03). Same anchor,
 * tool, action and arguments give the same key, so two identical writes in one
 * plan collapse into one at the provider.
 */
export function providerIdempotencyKey(params: {
  orgId: string;
  tool: string;
  action: string;
  payload: unknown;
  workflowId?: string;
  approvedPendingActionId?: string;
}): string | undefined {
  const anchor = params.approvedPendingActionId
    ? `approval:${params.approvedPendingActionId}`
    : params.workflowId
      ? `wf:${params.workflowId}`
      : '';
  if (!anchor) return undefined;
  const digest = createHash('sha256')
    .update([params.orgId, anchor, params.tool.toLowerCase(), params.action.toLowerCase(), stableJson(params.payload)].join('\u0000'))
    .digest('hex');
  return `darex-${digest.slice(0, 40)}`;
}

export interface ToolModule {
  actions: readonly string[];
  risk: (action: string) => ToolRisk;
  confirm: (action: string) => boolean;
  execute: (ctx: ToolActionContext) => Promise<ToolExecutionResult>;
}

export function confirmFromRisk(riskFn: (action: string) => ToolRisk): (action: string) => boolean {
  return (action) => confirmForRisk(riskFn(action));
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = TOOL_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  // Honor a caller-provided signal, the executor's ambient signal, AND the
  // timeout, whichever fires first.
  const upstream = [init.signal, currentToolSignal()].filter((s): s is AbortSignal => Boolean(s));
  for (const s of upstream) {
    if (s.aborted) controller.abort();
    else s.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, TOOL_EXECUTION_TIMEOUT_MS));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    for (const s of upstream) s.removeEventListener('abort', onCallerAbort);
  }
}

export function apiError(
  tool: string,
  action: string,
  timestamp: string,
  message: string,
  data: Record<string, unknown> | null = null,
): ToolExecutionResult {
  return { tool, action, status: 'error', message, data, timestamp };
}

export async function getNangoAccessToken(connectionId: string, providerKey: string): Promise<string | null> {
  const data = await getNangoConnection(connectionId, providerKey);
  return data?.credentials?.raw?.access_token || data?.credentials?.access_token || null;
}

// Short-lived token cache: tool fan-out (calendar + drive + gmail in one turn)
// must not pay a 10s Nango round-trip per call. Successes only, 60s TTL.
const nangoCache = new Map<string, { data: any; expiresAt: number }>();
const NANGO_CACHE_TTL_MS = 60_000;

function nangoCacheGet(key: string): any | undefined {
  const hit = nangoCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  nangoCache.delete(key);
  return undefined;
}

export async function getNangoConnection(connectionId: string, providerKey: string): Promise<any | null> {
  if (!NANGO_SECRET_KEY) {
    console.warn('[Tool Executor] NANGO_SECRET_KEY is not set — cannot fetch OAuth token');
    return null;
  }
  const cacheKey = `${connectionId}\n${providerKey}`;
  const cached = nangoCacheGet(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetchWithTimeout(`${NANGO_HOST}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`, {
      headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` },
    }, NANGO_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[Nango] Token fetch failed for ${connectionId} (${providerKey}): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    nangoCache.set(cacheKey, { data, expiresAt: Date.now() + NANGO_CACHE_TTL_MS });
    return data;
  } catch (err: any) {
    console.warn(`[Nango] Token fetch error for ${connectionId}:`, err.message);
    return null;
  }
}

function connectPath(tool: string): string {
  return connectorSignInPath(tool);
}

export function notConnected(tool: string, action: string, timestamp: string): ToolExecutionResult {
  const path = connectPath(tool);
  return {
    tool,
    action,
    status: 'error',
    message: `${tool} is not signed in (not connected). Connect it at ${path}. Do not invent ${tool} data. Continue the rest of the request with tools that are signed in.`,
    data: { connected: false, setupUrl: path },
    timestamp,
  };
}

/** Token existed but was revoked, expired, or rejected by the provider (401/403). */
export function revoked(
  tool: string,
  action: string,
  timestamp: string,
  detail?: string,
): ToolExecutionResult {
  const suffix = detail ? `: ${detail}` : '';
  return {
    tool,
    action,
    status: 'error',
    message: `${tool} connection revoked or expired${suffix}. Re-authorize at ${connectPath(tool)}.`,
    data: { connected: false, setupUrl: connectPath(tool), reason: 'revoked' },
    timestamp,
  };
}

export function isProviderUnauthorized(status: number): boolean {
  return status === 401 || status === 403;
}

export type NangoAuthState =
  | { kind: 'never-configured' }
  | { kind: 'revoked'; detail: string }
  | { kind: 'connected'; accessToken: string; connection: Record<string, unknown> };

export function isGoogleScopeSufficient(primaryKey: string, scope?: string): boolean {
  if (!scope || typeof scope !== 'string') return true;
  const s = scope.toLowerCase();
  if (primaryKey === 'google-drive') return s.includes('drive');
  if (primaryKey === 'google-docs') return s.includes('documents') || s.includes('drive');
  if (primaryKey === 'google-sheets') return s.includes('spreadsheets') || s.includes('drive');
  if (primaryKey === 'google-slides') return s.includes('presentations') || s.includes('drive');
  if (primaryKey === 'google-calendar') return s.includes('calendar');
  if (primaryKey === 'gmail') return s.includes('gmail') || s.includes('mail.google.com');
  if (primaryKey === 'google-contacts') return s.includes('contacts') || s.includes('people');
  if (primaryKey === 'google-tasks') return s.includes('tasks');
  if (primaryKey === 'google-forms') return s.includes('forms') || s.includes('drive');
  if (primaryKey === 'google-chat') return s.includes('chat');
  if (primaryKey === 'google-meet') return s.includes('meet') || s.includes('conference');
  return true;
}

/**
 * Distinguish never-configured (Nango 404 / no row) from revoked (refresh
 * failed or connection with no token). Probes provider keys in parallel and
 * caches the winning token for 60s — sequential 10s probes used to add
 * 20-30s to multi-key tools (salesforce, microsoft, quickbooks).
 */
export async function resolveNangoAuth(
  connectionId: string | readonly string[],
  providerKeys: string | readonly string[],
  scopeValidator?: (scope?: string) => boolean,
): Promise<NangoAuthState> {
  if (!NANGO_SECRET_KEY) {
    return { kind: 'never-configured' };
  }
  const connList = typeof connectionId === 'string' ? [connectionId] : connectionId;
  const keys = typeof providerKeys === 'string' ? [providerKeys] : providerKeys;

  let lastRevoked: Extract<NangoAuthState, { kind: 'revoked' }> | null = null;

  for (const conn of connList) {
    // Fast path: cached winning token from a recent probe.
    for (const providerKey of keys) {
      const cached = nangoCacheGet(`${conn}\n${providerKey}`);
      const token = cached?.credentials?.raw?.access_token || cached?.credentials?.access_token || null;
      const scope = cached?.credentials?.raw?.scope || cached?.credentials?.scope;
      if (typeof token === 'string' && token.length > 0 && (!scopeValidator || scopeValidator(scope))) {
        return { kind: 'connected', accessToken: token, connection: cached };
      }
    }

    const probe = async (providerKey: string): Promise<NangoAuthState> => {
      try {
        const res = await fetchWithTimeout(
          `${NANGO_HOST}/connection/${encodeURIComponent(conn)}?provider_config_key=${encodeURIComponent(providerKey)}`,
          { headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` } },
          NANGO_TIMEOUT_MS,
        );
        if (res.status === 404) return { kind: 'never-configured' };
        const bodyText = await res.text().catch(() => '');
        if (!res.ok) {
          const lower = bodyText.toLowerCase();
          if (res.status === 400 || res.status === 401 || /refresh|revok|expir|invalid_grant/.test(lower)) {
            return { kind: 'revoked', detail: bodyText.slice(0, 200) };
          }
          return { kind: 'never-configured' };
        }
        const data = JSON.parse(bodyText || '{}') as Record<string, any>;
        const token =
          data?.credentials?.raw?.access_token
          || data?.credentials?.access_token
          || null;
        const scope = data?.credentials?.raw?.scope || data?.credentials?.scope;
        if (typeof token === 'string' && token.length > 0 && (!scopeValidator || scopeValidator(scope))) {
          nangoCache.set(`${conn}\n${providerKey}`, { data, expiresAt: Date.now() + NANGO_CACHE_TTL_MS });
          return { kind: 'connected', accessToken: token, connection: data };
        }
        return { kind: 'revoked', detail: 'Nango connection exists but has no access token' };
      } catch (err: any) {
        console.warn(`[Nango] Auth resolve error for ${conn}/${providerKey}:`, err?.message);
        return { kind: 'never-configured' };
      }
    };

    const results = await Promise.all(keys.map(probe));
    const connected = results.find((r): r is Extract<NangoAuthState, { kind: 'connected' }> => r.kind === 'connected');
    if (connected) return connected;
    const revokedResult = results.find((r): r is Extract<NangoAuthState, { kind: 'revoked' }> => r.kind === 'revoked');
    if (revokedResult && !lastRevoked) lastRevoked = revokedResult;
  }

  if (lastRevoked) return lastRevoked;
  return { kind: 'never-configured' };
}

/**
 * Resolves Google OAuth credentials across all known Google configurations.
 * Because Google OAuth tokens include the union of authorized scopes for the
 * workspace, an org that connected Drive, Gmail, or Calendar can use other Google
 * tools without re-authorizing each individually. Validates scope sufficiency.
 */
export async function resolveGoogleAuth(
  orgId: string,
  primaryKey: string,
): Promise<NangoAuthState> {
  const connIds = [
    `${orgId}_${primaryKey}`,
    `${orgId}_google`,
    `${orgId}_google-drive`,
    `${orgId}_gmail`,
    `${orgId}_google-calendar`,
    `${orgId}_google-docs`,
    `${orgId}_google-sheets`,
    `${orgId}_google-slides`,
  ];
  const keys = [primaryKey, 'google', 'google-drive', 'gmail', 'google-calendar', 'google-mail'];
  return resolveNangoAuth(connIds, keys, (scope) => isGoogleScopeSufficient(primaryKey, scope));
}

/**
 * OAuth-token-or-honest-error helper for provider modules still on the legacy
 * `getNangoAccessToken` path (null conflates never-connected vs revoked).
 * Returns the access token, or a ready-to-return ToolExecutionResult that
 * distinguishes revoked (re-authorize) from never-connected (connect).
 */
export function nangoAuthError(
  tool: string,
  action: string,
  timestamp: string,
  state: Extract<NangoAuthState, { kind: 'never-configured' } | { kind: 'revoked' }>,
): ToolExecutionResult {
  if (state.kind === 'revoked') return revoked(tool, action, timestamp, state.detail);
  return notConnected(tool, action, timestamp);
}
