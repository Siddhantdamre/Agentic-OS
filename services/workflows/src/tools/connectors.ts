/**
 * Read-only connector status / ping for the session org.
 * Connect and disconnect stay human-only (OAuth cards on /connectors); this
 * tool never changes a connection. `connected:true` is reported only when the
 * live Nango probe succeeds — org_connectors.status is a cache and is shown
 * as `cachedStatus`, never as the truth.
 */
import { connectorSignInPath } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import type { NangoAuthState, ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, resolveGoogleAuth, resolveNangoAuth, withOrgScopedClient } from './shared.js';

const ACTIONS = ['status', 'ping', 'list'] as const;

/** Upper bound on live probes per call so one turn cannot fan out unbounded. */
const MAX_PROBES = 25;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

export interface ConnectorRow {
  key: string;
  nangoKey: string | null;
  name: string;
  category: string;
  authMode: string;
  cachedStatus: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

export interface ConnectorStatus {
  key: string;
  name: string;
  category: string;
  authMode: string;
  connected: boolean;
  /** live = Nango probe ran; cache = only the org_connectors row, not verified. */
  verifiedBy: 'live' | 'cache';
  state: 'connected' | 'revoked' | 'not_connected' | 'unverified';
  cachedStatus: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  connectUrl: string;
}

export type ProbeFn = (orgId: string, keys: string[], connectorKey?: string) => Promise<NangoAuthState['kind']>;

export const liveProbe: ProbeFn = async (orgId, keys, connectorKey) => {
  const primary = connectorKey || keys[0];
  if (!primary) return 'never-configured';

  // 1. Google Workspace umbrella resolution
  const isGoogle = primary === 'gmail' || primary.startsWith('google-') || primary === 'google';
  if (isGoogle) {
    return (await resolveGoogleAuth(orgId, primary)).kind;
  }

  // 2. Standard OAuth connectors
  const connIds = Array.from(
    new Set([
      `${orgId}_${primary}`,
      ...keys.map((k) => `${orgId}_${k}`),
      orgId,
    ]),
  );
  return (await resolveNangoAuth(connIds, keys)).kind;
};

/** Pure builder: probes OAuth connectors live, never trusts the cache for `connected`. */
export async function buildConnectorStatuses(
  orgId: string,
  rows: ConnectorRow[],
  probe: ProbeFn,
  nangoConfigured: boolean,
): Promise<ConnectorStatus[]> {
  return Promise.all(
    rows.map(async (row): Promise<ConnectorStatus> => {
      const base = {
        key: row.key,
        name: row.name,
        category: row.category,
        authMode: row.authMode,
        cachedStatus: row.cachedStatus,
        lastOkAt: row.lastOkAt,
        lastError: row.lastError,
        connectUrl: connectorSignInPath(row.key),
      };
      if (row.authMode !== 'oauth') {
        // BYOK / API-key connectors have no Nango connection to probe. Do not claim a verified state.
        return { ...base, connected: false, verifiedBy: 'cache', state: 'unverified' };
      }
      if (!nangoConfigured) {
        return { ...base, connected: false, verifiedBy: 'cache', state: 'unverified' };
      }
      const keys = Array.from(new Set([row.key, row.nangoKey].filter((k): k is string => !!k)));
      const kind = await probe(orgId, keys, row.key);
      if (kind === 'connected') return { ...base, connected: true, verifiedBy: 'live', state: 'connected' };
      if (kind === 'revoked') return { ...base, connected: false, verifiedBy: 'live', state: 'revoked' };
      return { ...base, connected: false, verifiedBy: 'live', state: 'not_connected' };
    }),
  );
}

async function execute(ctx: ToolActionContext) {
  const { orgId, timestamp, payload, actionName } = ctx;
  const action = actionName || 'status';
  const wanted =
    typeof payload.connector === 'string' && payload.connector.trim()
      ? payload.connector.trim().toLowerCase().replace(/_/g, '-')
      : null;
  try {
    const rows = await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query<{
        key: string;
        nango_key: string | null;
        name: string;
        category: string;
        auth_mode: string;
        status: string | null;
        last_ok_at: string | null;
        last_error: string | null;
      }>(
        `SELECT d.key, d.nango_key, d.name, d.category, d.auth_mode,
                c.status, c.last_ok_at, c.last_error
           FROM connector_defs d
           LEFT JOIN org_connectors c ON c.connector_key = d.key AND c.org_id = $1
          WHERE ($2::text IS NULL OR d.key = $2)
            AND ($2::text IS NOT NULL OR c.id IS NOT NULL)
          ORDER BY d.sort_order ASC, d.key ASC
          LIMIT $3`,
        [orgId, wanted, MAX_PROBES],
      );
      return res.rows.map(
        (r): ConnectorRow => ({
          key: r.key,
          nangoKey: r.nango_key,
          name: r.name,
          category: r.category,
          authMode: r.auth_mode,
          cachedStatus: r.status,
          lastOkAt: r.last_ok_at,
          lastError: r.last_error,
        }),
      );
    });

    if (wanted && rows.length === 0) {
      return apiError('connectors', action, timestamp, `Unknown connector "${wanted}". See /connectors for the catalog.`, {
        connected: false,
        setupUrl: '/connectors',
      });
    }

    const statuses = await buildConnectorStatuses(orgId, rows, liveProbe, !!process.env.NANGO_SECRET_KEY);
    const connected = statuses.filter((s) => s.connected).length;
    const message =
      statuses.length === 0
        ? 'No connectors have been set up for this org. Connect tools at /connectors.'
        : `${connected} of ${statuses.length} connector(s) verified connected. Connect or disconnect on /connectors; this tool is read-only.`;
    return {
      tool: 'connectors',
      action,
      status: 'executed' as const,
      message,
      data: { connectors: statuses, connectedCount: connected, setupUrl: '/connectors' },
      timestamp,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError('connectors', action, timestamp, `Connector status unavailable: ${message}`, {
      connected: false,
      setupUrl: '/connectors',
    });
  }
}

export const connectors: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
