import { Nango } from '@nangohq/node';
import { connectionIdsFor, nangoKeysFor } from './providers';
import {
  CONNECTORS_RECONNECT_URL,
  ConnectorStatus,
  ConnectorType,
  notConnectedResult,
} from './types';

function isAuthFailureMessage(msg: string): boolean {
  return /401|403|invalid_grant|token.*(expired|revoked|invalid)|expired.*token|refresh.*fail|unauthorized|forbidden/i.test(
    msg
  );
}

function enrichAuthError(err: any, provider: string, reason: 'not_connected' | 'expired' | 'revoked' | 'nango_unconfigured') {
  const base = notConnectedResult(
    reason,
    err?.message || `No usable OAuth credentials for ${provider}. Reconnect at ${CONNECTORS_RECONNECT_URL}.`,
    provider
  );
  const out: any = err instanceof Error ? err : new Error(base.message);
  out.message = base.message;
  out.status = reason === 'nango_unconfigured' ? 503 : reason === 'not_connected' ? 404 : 401;
  out.connected = false;
  out.reconnectUrl = base.reconnectUrl;
  out.setupUrl = base.setupUrl;
  out.reason = base.reason;
  out.provider = provider;
  return out;
}

/** Process-local 429 cooldown keyed by orgId:provider (ms epoch). */
const rateLimitUntil = new Map<string, number>();

export class NangoConnectorClient {
  private nango: Nango | null;
  private resolvedKeys = new Map<string, { providerConfigKey: string; connectionId: string }>();

  constructor() {
    const host = process.env.NANGO_HOST || 'http://localhost:3003';
    const secretKey = process.env.NANGO_SECRET_KEY;
    this.nango = secretKey ? new Nango({ host, secretKey }) : null;
  }

  public isConfigured(): boolean {
    return this.nango !== null;
  }

  private requireNango(): Nango {
    if (!this.nango) {
      throw enrichAuthError(
        new Error('NANGO_SECRET_KEY is not set — cannot talk to Nango'),
        'nango',
        'nango_unconfigured'
      );
    }
    return this.nango;
  }

  /** Drop cached live-connection pair so the next call re-probes Nango. */
  public invalidateConnectionCache(orgId: string, provider: string): void {
    this.resolvedKeys.delete(`${orgId}:${provider}`);
  }

  /**
   * Generates connection ID scoped to org_id and catalog provider id.
   */
  public getConnectionId(orgId: string, provider: ConnectorType | string): string {
    return `${orgId}_${provider}`;
  }

  /**
   * Resolves the live Nango (providerConfigKey, connectionId) pair for this org.
   */
  public async resolveLiveConnection(
    orgId: string,
    provider: string
  ): Promise<{ providerConfigKey: string; connectionId: string } | null> {
    const cacheKey = `${orgId}:${provider}`;
    const cached = this.resolvedKeys.get(cacheKey);
    if (cached) return cached;

    const nango = this.requireNango();
    const keys = nangoKeysFor(provider);
    const ids = connectionIdsFor(orgId, provider);

    for (const key of keys) {
      for (const connectionId of ids) {
        try {
          const conn = await nango.getConnection(key, connectionId);
          if (conn) {
            const resolved = { providerConfigKey: key, connectionId };
            this.resolvedKeys.set(cacheKey, resolved);
            return resolved;
          }
        } catch {
          // try next pair
        }
      }
    }
    return null;
  }

  /**
   * Fetches connection status from Nango for a specific tenant and integration
   */
  public async getConnectionStatus(orgId: string, provider: ConnectorType): Promise<ConnectorStatus> {
    const connectionId = this.getConnectionId(orgId, provider);
    if (!this.nango) {
      const honest = notConnectedResult('nango_unconfigured', 'NANGO_SECRET_KEY is not set', provider);
      return {
        connectionId,
        provider,
        orgId,
        connected: false,
        error: honest.message,
        reconnectUrl: honest.reconnectUrl,
      };
    }
    try {
      const live = await this.resolveLiveConnection(orgId, provider);
      if (!live) {
        const honest = notConnectedResult(
          'not_connected',
          `No Nango OAuth connection for ${provider}. Reconnect at ${CONNECTORS_RECONNECT_URL}.`,
          provider
        );
        return {
          connectionId,
          provider,
          orgId,
          connected: false,
          error: honest.message,
          reconnectUrl: honest.reconnectUrl,
        };
      }
      return {
        connectionId: live.connectionId,
        provider,
        orgId,
        connected: true,
        lastSyncedAt: new Date().toISOString(),
      };
    } catch (err: any) {
      const reason = isAuthFailureMessage(String(err?.message || '')) ? 'expired' : 'not_connected';
      const honest = notConnectedResult(
        reason,
        err.message || `Not connected — reconnect at ${CONNECTORS_RECONNECT_URL}`,
        provider
      );
      return {
        connectionId,
        provider,
        orgId,
        connected: false,
        error: honest.message,
        reconnectUrl: honest.reconnectUrl,
      };
    }
  }

  public async deleteConnection(orgId: string, provider: string): Promise<void> {
    const nango = this.requireNango();
    const keys = nangoKeysFor(provider);
    const ids = connectionIdsFor(orgId, provider);
    const errors: string[] = [];
    let deleted = false;

    for (const key of keys) {
      for (const connectionId of ids) {
        try {
          await nango.deleteConnection(connectionId, key);
          deleted = true;
        } catch (err: any) {
          const msg = String(err?.message || err);
          if (!/404|not found|doesn't exist|does not exist/i.test(msg)) {
            errors.push(msg);
          }
        }
      }
    }

    this.resolvedKeys.delete(`${orgId}:${provider}`);
    if (!deleted && errors.length > 0) {
      throw new Error(errors[0]);
    }
  }

  /**
   * Triggers an action or proxies a request to Nango.
   * Honors in-process 429 cooldown (Retry-After) so parallel callers do not stampede.
   */
  public async proxyRequest(
    orgId: string,
    provider: ConnectorType | string,
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    data?: any,
    headers?: Record<string, string>
  ): Promise<any> {
    const cooldownKey = `${orgId}:${provider}`;
    const until = rateLimitUntil.get(cooldownKey) || 0;
    if (until > Date.now()) {
      const waitMs = until - Date.now();
      const err: any = new Error(
        `Rate limited for ${provider}; retry after ${Math.ceil(waitMs / 1000)}s (Retry-After cooldown).`
      );
      err.status = 429;
      err.connected = true;
      err.retryAfterMs = waitMs;
      throw err;
    }

    const nango = this.requireNango();
    const live = await this.resolveLiveConnection(orgId, provider);
    if (!live) {
      throw enrichAuthError(
        new Error(
          `No Nango OAuth connection for ${provider}. Reconnect at ${CONNECTORS_RECONNECT_URL}.`
        ),
        provider,
        'not_connected'
      );
    }
    try {
      const response = await nango.proxy({
        method,
        endpoint,
        providerConfigKey: live.providerConfigKey,
        connectionId: live.connectionId,
        data,
        headers,
      });
      return response.data;
    } catch (err: any) {
      const status = Number(err?.status || err?.response?.status || 0);
      const msg = String(err?.message || err?.response?.data?.error || err);
      if (status === 429) {
        const retryHeader =
          err?.response?.headers?.['retry-after'] ||
          err?.headers?.['retry-after'] ||
          err?.retryAfter;
        const retrySec = Number(retryHeader);
        const cooldownMs =
          Number.isFinite(retrySec) && retrySec > 0
            ? retrySec * 1000
            : 60_000;
        rateLimitUntil.set(cooldownKey, Date.now() + cooldownMs);
        const cooled: any = new Error(
          `Provider ${provider} returned HTTP 429. Cooling down ${Math.ceil(cooldownMs / 1000)}s before retry.`
        );
        cooled.status = 429;
        cooled.connected = true;
        cooled.retryAfterMs = cooldownMs;
        throw cooled;
      }
      if (status === 401 || status === 403 || isAuthFailureMessage(msg)) {
        this.invalidateConnectionCache(orgId, provider);
        throw enrichAuthError(
          new Error(
            `OAuth credentials for ${provider} expired or were revoked (${status || 'auth'}). Reconnect at ${CONNECTORS_RECONNECT_URL}.`
          ),
          provider,
          status === 403 ? 'revoked' : 'expired'
        );
      }
      throw err;
    }
  }
}
