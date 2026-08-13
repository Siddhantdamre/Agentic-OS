import { catalogIdFromConnectionId, connectionIdsFor, nangoKeysFor } from '@darex/connectors';
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

async function nangoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { host, secretKey } = getNangoServerConfig();
  if (!secretKey) {
    throw new Error('NANGO_SECRET_KEY is not set');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
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

export async function listNangoConnections(orgId: string): Promise<NangoConnectionSummary[]> {
  if (!isNangoSecretConfigured()) return [];
  try {
    const res = await nangoFetch('/connection');
    if (!res.ok) return [];
    const body = await res.json();
    const rows: any[] = Array.isArray(body) ? body : body.connections || body.data || [];
    const out: NangoConnectionSummary[] = [];
    for (const row of rows) {
      const connectionId = String(row.connection_id || row.connectionId || '');
      const providerConfigKey = String(row.provider_config_key || row.providerConfigKey || row.provider || '');
      if (!connectionId || !connectionId.startsWith(`${orgId}_`)) continue;
      out.push({
        connectionId,
        providerConfigKey,
        catalogId: catalogIdFromConnectionId(orgId, connectionId),
      });
    }
    return out;
  } catch (err: any) {
    console.warn('[Nango] list connections failed:', err.message);
    return [];
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
): Promise<{ deleted: boolean; error?: string }> {
  if (!isNangoSecretConfigured()) {
    return { deleted: false, error: 'NANGO_SECRET_KEY is not set' };
  }
  const keys = nangoKeysFor(provider);
  const ids = connectionIdsFor(orgId, provider);
  let deleted = false;
  let lastError: string | undefined;
  for (const key of keys) {
    for (const connectionId of ids) {
      try {
        const res = await nangoFetch(
          `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(key)}`,
          { method: 'DELETE' }
        );
        if (res.ok) deleted = true;
        else if (res.status !== 404) lastError = `HTTP ${res.status}`;
      } catch (err: any) {
        lastError = err.message;
      }
    }
  }
  return { deleted: deleted || !lastError, error: deleted ? undefined : lastError };
}

export function primaryConnectionId(orgId: string, provider: string): string {
  return `${orgId}_${provider}`;
}