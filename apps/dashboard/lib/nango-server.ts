import { catalogIdFromConnectionId, catalogIdsFromConnectionId, connectionIdsFor, nangoKeysFor } from '@darex/connectors';
import { nangoUiUrl } from '@/lib/integrations-catalog';

const PLACEHOLDER_CLIENT_RE = /^(placeholder|changeme|your_?client|xxxx+|demo|example|todo|replace.?me)?$/i;

export interface NangoServerConfig {
  host: string;
  secretKey: string | undefined;
  publicKey: string | undefined;
  uiUrl: string;
}

export function getNangoServerConfig(): NangoServerConfig {
  return {
    host: process.env.NANGO_HOST || 'http://localhost:3003',
    secretKey: process.env.NANGO_SECRET_KEY,
    publicKey: process.env.NEXT_PUBLIC_NANGO_PUBLIC_KEY,
    uiUrl: nangoUiUrl(),
  };
}

export function isNangoSecretConfigured(): boolean {
  return Boolean(process.env.NANGO_SECRET_KEY);
}

function nangoTimeoutMs(): number {
  const n = parseInt(process.env.NANGO_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

async function nangoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { host, secretKey } = getNangoServerConfig();
  if (!secretKey) {
    throw new Error('NANGO_SECRET_KEY is not set');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), nangoTimeoutMs());
  try {
    return await fetch(`${host}${path}`, {
      ...init,
      signal: init.signal ?? ctrl.signal,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface NangoConfigStatus {
  uniqueKey: string;
  provider?: string;
  configured: boolean;
  reason?: string;
}

function isPlaceholderClientId(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  if (!s) return true;
  return PLACEHOLDER_CLIENT_RE.test(s);
}

export async function listNangoConfigs(): Promise<NangoConfigStatus[]> {
  if (!isNangoSecretConfigured()) return [];
  try {
    const res = await nangoFetch('/config');
    if (!res.ok) return [];
    const body = await res.json();
    const rows: any[] = Array.isArray(body) ? body : body.configs || body.data || [];
    return rows
      .map((row) => {
        const uniqueKey = String(row.unique_key || row.uniqueKey || row.provider_config_key || '');
        const clientId = row.oauth_client_id ?? row.oauthClientId ?? row.client_id;
        const placeholder = isPlaceholderClientId(clientId);
        const configured = Boolean(uniqueKey) && (clientId === undefined ? true : !placeholder);
        return {
          uniqueKey,
          provider: row.provider as string | undefined,
          configured,
          reason:
            !uniqueKey
              ? 'invalid config'
              : clientId !== undefined && placeholder
                ? 'OAuth client ID in Nango is empty or a placeholder — paste a real client ID in the Nango UI'
                : undefined,
        };
      })
      .filter((c) => c.uniqueKey);
  } catch (err: any) {
    console.warn('[Nango] list configs failed:', err.message);
    return [];
  }
}

export async function getNangoConfigStatus(provider: string): Promise<NangoConfigStatus | null> {
  const configs = await listNangoConfigs();
  const keys = nangoKeysFor(provider);
  for (const key of keys) {
    const match = configs.find((c) => c.uniqueKey === key);
    if (match) return match;
  }
  return {
    uniqueKey: keys[0] || provider,
    configured: false,
    reason: `No Nango integration named ${keys.join(' / ')} — create it in ${nangoUiUrl()} and paste a real OAuth client ID`,
  };
}

export interface NangoConnectionSummary {
  connectionId: string;
  providerConfigKey: string;
  catalogId: string | null;
}

export interface NangoConnectionListResult {
  /** True only when Nango answered successfully — empty list then means truly none. */
  ok: boolean;
  connections: NangoConnectionSummary[];
  /**
   * Why `ok` is false. `auth` (401/403) and `unreachable` mean per-connection probes
   * cannot succeed either, so callers should skip them; `error` (other HTTP failure) may
   * still allow a single-connection lookup.
   */
  reason?: 'auth' | 'unreachable' | 'error' | 'unconfigured';
}

/**
 * List live Nango connections for an org. Distinguishes "Nango unreachable /
 * misconfigured" (`ok: false`) from "org has zero connections" (`ok: true`).
 * Callers must not demote local channel rows when `ok` is false.
 */
export async function listNangoConnections(orgId: string): Promise<NangoConnectionListResult> {
  if (!isNangoSecretConfigured()) return { ok: false, connections: [], reason: 'unconfigured' };
  try {
    const res = await nangoFetch('/connection');
    if (!res.ok) {
      return { ok: false, connections: [], reason: res.status === 401 || res.status === 403 ? 'auth' : 'error' };
    }
    const body = await res.json();
    const rows: any[] = Array.isArray(body) ? body : body.connections || body.data || [];
    const out: NangoConnectionSummary[] = [];
    for (const row of rows) {
      const connectionId = String(row.connection_id || row.connectionId || '');
      const providerConfigKey = String(row.provider_config_key || row.providerConfigKey || row.provider || '');
      if (!connectionId || !connectionId.startsWith(`${orgId}_`)) continue;
      const ids = catalogIdsFromConnectionId(orgId, connectionId);
      for (const catId of ids) {
        out.push({
          connectionId,
          providerConfigKey,
          catalogId: catId,
        });
      }
    }
    return { ok: true, connections: out };
  } catch (err: any) {
    console.warn('[Nango] list connections failed:', err.message);
    return { ok: false, connections: [], reason: 'unreachable' };
  }
}

/**
 * Returns true only if a real Nango OAuth connection exists for this org+provider.
 * This is the source of truth the agent tools rely on, so the UI must match it.
 */
export async function nangoConnectionExists(orgId: string, provider: string): Promise<boolean> {
  const conn = await getNangoConnection(orgId, provider);
  return conn !== null;
}

/**
 * Fetch the raw Nango connection record for an org+provider (or null).
 */
export async function getNangoConnection(
  orgId: string,
  provider: string
): Promise<any | null> {
  if (!isNangoSecretConfigured()) {
    console.warn('[Nango] NANGO_SECRET_KEY is not set — cannot verify connection status');
    return null;
  }
  const keys = nangoKeysFor(provider);
  const ids = connectionIdsFor(orgId, provider);
  try {
    for (const key of keys) {
      for (const connectionId of ids) {
        const res = await nangoFetch(
          `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(key)}`
        );
        if (res.ok) return await res.json();
      }
    }
    return null;
  } catch (err: any) {
    console.warn(`[Nango] Connection check failed for ${provider}:`, err.message);
    return null;
  }
}

export async function deleteNangoConnection(
  orgId: string,
  provider: string
): Promise<{ deleted: boolean; error?: string; nothingExisted?: boolean }> {
  if (!isNangoSecretConfigured()) {
    return { deleted: false, error: 'NANGO_SECRET_KEY is not set' };
  }
  const keys = nangoKeysFor(provider);
  const ids = connectionIdsFor(orgId, provider);
  let deleted = false;
  let foundAny = false;
  let lastError: string | undefined;
  for (const key of keys) {
    for (const connectionId of ids) {
      try {
        const res = await nangoFetch(
          `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(key)}`,
          { method: 'DELETE' }
        );
        if (res.ok) {
          deleted = true;
          foundAny = true;
        } else if (res.status === 404 || res.status === 400) {
          // Nothing at this key/id pair (404 = connection not found, 400 = provider not configured in Nango) — not an error, keep looking.
        } else {
          foundAny = true;
          lastError = `HTTP ${res.status}`;
        }
      } catch (err: any) {
        foundAny = true;
        lastError = err.message;
      }
    }
  }
  if (deleted) return { deleted: true };
  if (!foundAny) return { deleted: false, nothingExisted: true };
  return { deleted: false, error: lastError };
}

export function primaryConnectionId(orgId: string, provider: string): string {
  return `${orgId}_${provider}`;
}