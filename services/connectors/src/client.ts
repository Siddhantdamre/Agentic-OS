import { Nango } from '@nangohq/node';
import { ConnectorStatus, ConnectorType } from './types';

export class NangoConnectorClient {
  private nango: Nango;

  constructor() {
    const host = process.env.NANGO_HOST || 'http://localhost:3003';
    if (!process.env.NANGO_SECRET_KEY) {
      throw new Error('NANGO_SECRET_KEY is not set — configure it in services/connectors/.env');
    }
    const secretKey = process.env.NANGO_SECRET_KEY;
    this.nango = new Nango({ host, secretKey });
  }

  /**
   * Generates connection ID scoped to org_id and provider
   */
  public getConnectionId(orgId: string, provider: ConnectorType): string {
    return `darex_${orgId}_${provider}`;
  }

  /**
   * Fetches connection status from Nango for a specific tenant and integration
   */
  public async getConnectionStatus(orgId: string, provider: ConnectorType): Promise<ConnectorStatus> {
    const connectionId = this.getConnectionId(orgId, provider);
    try {
      const conn = await this.nango.getConnection(provider, connectionId);
      return {
        connectionId,
        provider,
        orgId,
        connected: !!conn,
        lastSyncedAt: new Date().toISOString(),
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

  /**
   * Triggers an action or proxies a request to Nango
   */
  public async proxyRequest(
    orgId: string,
    provider: ConnectorType,
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    data?: any,
    headers?: Record<string, string>
  ): Promise<any> {
    const connectionId = this.getConnectionId(orgId, provider);
    const response = await this.nango.proxy({
      method,
      endpoint,
      providerConfigKey: provider,
      connectionId,
      data,
      headers,
    });
    return response.data;
  }
}
