import { Nango } from '@nangohq/node';
import { connectionIdsFor, nangoKeysFor } from './providers';
import { ConnectorStatus, ConnectorType } from './types';

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
      throw new Error('NANGO_SECRET_KEY is not set — cannot talk to Nango');
    }
    return this.nango;
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
      return {
        connectionId,
        provider,
        orgId,
        connected: false,
        error: 'NANGO_SECRET_KEY is not set',
      };
    }
    try {
      const live = await this.resolveLiveConnection(orgId, provider);
      return {
        connectionId: live?.connectionId || connectionId,
        provider,
        orgId,
        connected: !!live,
        lastSyncedAt: live ? new Date().toISOString() : undefined,
        error: live ? undefined : 'Not connected',
      };
    } catch (err: any) {
      return {
        connectionId,
        provider,
        orgId,
        connected: false,
        error: err.message || 'Not connected',
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
   * Triggers an action or proxies a request to Nango
   */
  public async proxyRequest(
    orgId: string,
    provider: ConnectorType | string,
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    data?: any,
    headers?: Record<string, string>
  ): Promise<any> {
    const nango = this.requireNango();
    const live = await this.resolveLiveConnection(orgId, provider);
    if (!live) {
      const err: any = new Error(
        `No Nango OAuth connection for ${provider}. Connect at /connectors first.`
      );
      err.status = 404;
      err.connected = false;
      throw err;
    }
    const response = await nango.proxy({
      method,
      endpoint,
      providerConfigKey: live.providerConfigKey,
      connectionId: live.connectionId,
      data,
      headers,
    });
    return response.data;
  }
}
