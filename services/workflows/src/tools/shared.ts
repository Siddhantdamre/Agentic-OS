import { Pool, PoolClient } from 'pg';
import type { ToolExecutionResult } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import { confirmForRisk } from './risk.js';

export const NANGO_HOST = process.env.NANGO_HOST || 'http://localhost:3003';
export const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY; // Must be set — no insecure fallback
export const NANGO_TIMEOUT_MS = parseInt(process.env.NANGO_TIMEOUT_MS || '10000', 10);
export const TOOL_HTTP_TIMEOUT_MS = parseInt(process.env.TOOL_HTTP_TIMEOUT_MS || '20000', 10);

export const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
  max: 10,
});

/**
 * Session-level RLS (is_local=false). Transaction-local set_config dies at
 * autocommit, so the next query on darex_app would run with no org GUC.
 */
export async function withOrgScopedClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await dbPool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // always release the pool slot
    }
    client.release();
  }
}

export interface ToolActionContext {
  tool: string;
  action: string;
  actionName: string;
  payload: Record<string, any>;
  orgId: string;
  timestamp: string;
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
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
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

export async function getNangoConnection(connectionId: string, providerKey: string): Promise<any | null> {
  if (!NANGO_SECRET_KEY) {
    console.warn('[Tool Executor] NANGO_SECRET_KEY is not set — cannot fetch OAuth token');
    return null;
  }
  try {
    const res = await fetchWithTimeout(`${NANGO_HOST}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`, {
      headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` },
    }, NANGO_TIMEOUT_MS);
    if (!res.ok) {
      console.warn(`[Nango] Token fetch failed for ${connectionId} (${providerKey}): HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.warn(`[Nango] Token fetch error for ${connectionId}:`, err.message);
    return null;
  }
}

export function notConnected(tool: string, action: string, timestamp: string): ToolExecutionResult {
  return {
    tool,
    action,
    status: 'error',
    message: `${tool} not connected. Authorize via Nango OAuth at /connectors to enable real actions.`,
    data: { connected: false, setupUrl: '/connectors' },
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
    message: `${tool} connection revoked or expired${suffix}. Re-authorize at /connectors.`,
    data: { connected: false, setupUrl: '/connectors', reason: 'revoked' },
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

/**
 * Distinguish never-configured (Nango 404 / no row) from revoked (refresh
 * failed or connection with no token). Tries provider keys in order.
 */
export async function resolveNangoAuth(
  connectionId: string,
  providerKeys: string | readonly string[],
): Promise<NangoAuthState> {
  if (!NANGO_SECRET_KEY) {
    return { kind: 'never-configured' };
  }
  const keys = typeof providerKeys === 'string' ? [providerKeys] : providerKeys;
  let sawRevoked = false;
  let revokedDetail = '';
  for (const providerKey of keys) {
    try {
      const res = await fetchWithTimeout(
        `${NANGO_HOST}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
        { headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` } },
        NANGO_TIMEOUT_MS,
      );
      if (res.status === 404) continue;
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        const lower = bodyText.toLowerCase();
        if (res.status === 400 || res.status === 401 || /refresh|revok|expir|invalid_grant/.test(lower)) {
          sawRevoked = true;
          revokedDetail = bodyText.slice(0, 200);
        }
        continue;
      }
      const data = JSON.parse(bodyText || '{}') as Record<string, any>;
      const token =
        data?.credentials?.raw?.access_token
        || data?.credentials?.access_token
        || null;
      if (typeof token === 'string' && token.length > 0) {
        return { kind: 'connected', accessToken: token, connection: data };
      }
      sawRevoked = true;
      revokedDetail = 'Nango connection exists but has no access token';
    } catch (err: any) {
      console.warn(`[Nango] Auth resolve error for ${connectionId}/${providerKey}:`, err?.message);
    }
  }
  if (sawRevoked) return { kind: 'revoked', detail: revokedDetail };
  return { kind: 'never-configured' };
}
