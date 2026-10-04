/**
 * Post soft-delete purge saga: cancel known Temporal workflows, disconnect
 * Nango/org connectors, wipe org-scoped memory tables. Failures never roll
 * back orgs.status = soft_deleted — callers fire-and-forget after commit.
 */
import type { PoolClient } from 'pg';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';
import { getOrgScopedClient } from '@/lib/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { upsertOrgConnector } from '@/lib/connector-registry';
import {
  deleteNangoConnection,
  isNangoSecretConfigured,
} from '@/lib/nango-server';

export type OrgPurgeStepStatus = 'ok' | 'skipped' | 'error';

export type OrgPurgeStepResult = {
  status: OrgPurgeStepStatus;
  reason?: string;
  error?: string;
  cancelled?: string[];
  notFound?: string[];
  disconnected?: string[];
  nangoLocalOnly?: boolean;
  deleted?: Record<string, number>;
};

export type OrgPurgeResult = {
  temporal: OrgPurgeStepResult;
  nango: OrgPurgeStepResult;
  memory: OrgPurgeStepResult;
};

export type OrgPurgeParams = {
  orgId: string;
  actorUserId?: string | null;
  source: 'owner' | 'platform';
};

/** Deterministic periodic / org-scoped workflow ids already used at provision. */
function knownPeriodicWorkflowIds(orgId: string): string[] {
  return [
    `open-loops:${orgId}`,
    `morning-check:${orgId}`,
    `stuck-work:${orgId}`,
    `rep-followup-sla:${orgId}`,
    `workload-balancer:${orgId}`,
    `growth-watch:${orgId}`,
    `market-scout:${orgId}`,
    `meeting-dossier:${orgId}`,
    `reply-sorter:${orgId}`,
    `customer-insights:${orgId}`,
    `meeting-prep:${orgId}`,
    `system-reconciliation:${orgId}`,
    `owner-briefing-${orgId}`,
  ];
}

/**
 * Memory tables with org_id (013 / 022), plus earlier memory text kept for
 * restore (`memory_revisions`) and connector sync positions (`sync_cursors`).
 * Missing tables are skipped.
 */
const MEMORY_PURGE_TABLES = [
  'memory_revisions',
  'sync_cursors',
  'memory_edges',
  'org_memory',
  'employee_memory',
  'entity_memory',
  'conversation_memory',
  'fact_conflicts',
  'facts',
] as const;

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

function isWorkflowNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name || '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === 'WorkflowNotFoundError' ||
    /workflow.*not found|not found for|unknown execution/i.test(message)
  );
}

async function collectStoredWorkflowIds(client: PoolClient, orgId: string): Promise<string[]> {
  const ids = new Set<string>();

  try {
    const workItems = await client.query<{ temporal_workflow_id: string | null }>(
      `SELECT temporal_workflow_id FROM work_items
        WHERE org_id = $1 AND temporal_workflow_id IS NOT NULL`,
      [orgId]
    );
    for (const row of workItems.rows) {
      const id = row.temporal_workflow_id?.trim();
      if (id) ids.add(id);
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }

  try {
    const conversations = await client.query<{ temporal_workflow_id: string | null }>(
      `SELECT temporal_workflow_id FROM conversations
        WHERE org_id = $1 AND temporal_workflow_id IS NOT NULL`,
      [orgId]
    );
    for (const row of conversations.rows) {
      const id = row.temporal_workflow_id?.trim();
      if (id) ids.add(id);
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }

  return [...ids];
}

async function purgeTemporal(orgId: string): Promise<OrgPurgeStepResult> {
  let client: PoolClient | null = null;
  let storedIds: string[] = [];
  try {
    const scoped = await getOrgScopedClient(orgId);
    client = scoped.client;
    storedIds = await collectStoredWorkflowIds(client, orgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: 'org_purge.temporal.lookup_failed',
        orgId,
        reason: message.slice(0, 200),
      })
    );
  } finally {
    client?.release();
  }

  const workflowIds = [...new Set([...knownPeriodicWorkflowIds(orgId), ...storedIds])];
  if (workflowIds.length === 0) {
    console.warn(
      JSON.stringify({
        event: 'org_purge.temporal.skip',
        orgId,
        reason: 'no_workflow_ids',
      })
    );
    return { status: 'skipped', reason: 'no_workflow_ids' };
  }

  const temporal = await getTemporalClient();
  if (!temporal) {
    console.warn(
      JSON.stringify({
        event: 'org_purge.temporal.skip',
        orgId,
        reason: 'temporal_unreachable',
        candidateCount: workflowIds.length,
      })
    );
    return { status: 'skipped', reason: 'temporal_unreachable' };
  }

  const cancelled: string[] = [];
  const notFound: string[] = [];
  const errors: string[] = [];

  for (const workflowId of workflowIds) {
    try {
      const handle = temporal.workflow.getHandle(workflowId);
      await handle.cancel();
      cancelled.push(workflowId);
    } catch (err) {
      if (isWorkflowNotFound(err)) {
        notFound.push(workflowId);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${workflowId}: ${message.slice(0, 120)}`);
    }
  }

  if (errors.length > 0 && cancelled.length === 0) {
    return {
      status: 'error',
      error: errors.slice(0, 5).join('; '),
      cancelled,
      notFound,
    };
  }

  return {
    status: 'ok',
    cancelled,
    notFound,
    ...(errors.length > 0 ? { reason: `partial_errors:${errors.length}` } : {}),
  };
}

async function disconnectOneConnector(
  client: PoolClient,
  orgId: string,
  provider: string,
  actorUserId: string | null | undefined,
  nangoConfigured: boolean
): Promise<{ provider: string; nangoDeleted: boolean; localOnly: boolean; error?: string }> {
  let nangoDeleted = false;
  let localOnly = !nangoConfigured;

  if (nangoConfigured) {
    const nangoRes = await deleteNangoConnection(orgId, provider);
    if (!nangoRes.deleted && !nangoRes.nothingExisted && nangoRes.error) {
      return {
        provider,
        nangoDeleted: false,
        localOnly: false,
        error: nangoRes.error,
      };
    }
    nangoDeleted = Boolean(nangoRes.deleted);
  }

  const message = !nangoConfigured
    ? 'NANGO_SECRET_KEY is not set — disconnected locally; OAuth tokens were not revoked in Nango.'
    : nangoDeleted
      ? `${provider} disconnected (Nango connection deleted)`
      : `${provider} disconnected locally (no Nango connection existed)`;

  await client.query(
    `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, meta, connected_at)
     VALUES ($1, $2, 'disconnected', NULL, '{}'::jsonb, NULL)
     ON CONFLICT (org_id, channel_type, account_key)
     DO UPDATE SET status = 'disconnected', nango_connection_id = NULL,
                   meta = '{}'::jsonb, connected_at = NULL`,
    [orgId, provider]
  );

  try {
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
       VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
      [orgId, provider, message]
    );
  } catch {
    // channel_logs optional
  }

  await upsertOrgConnector(client, orgId, provider, {
    status: 'disconnected',
    nangoConnectionId: null,
    scopes: [],
    lastOkAt: null,
    lastError: localOnly ? 'nango_unconfigured_local_disconnect' : null,
  });

  try {
    await recordAuditEvent(
      {
        orgId,
        kind: 'connector.disconnect',
        actor: actorUserId
          ? { actorType: 'user', userId: actorUserId }
          : { actorType: 'system', component: 'org-purge' },
        tool: provider,
        action: 'disconnect',
        resultStatus: 'ok',
        riskClass: 'high',
        payload: {
          accountId: 'primary',
          nangoDeleted,
          nangoConfigured,
          orgPurge: true,
        },
      },
      { client, orgId }
    );
  } catch {
    // audit best-effort
  }

  return { provider, nangoDeleted, localOnly };
}

async function purgeNango(
  orgId: string,
  actorUserId?: string | null
): Promise<OrgPurgeStepResult> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    let rows: { connector_key: string }[] = [];
    try {
      const res = await client.query<{ connector_key: string }>(
        `SELECT connector_key FROM org_connectors
          WHERE org_id = $1
            AND status = 'connected'`,
        [orgId]
      );
      rows = res.rows;
    } catch (err) {
      if (isMissingRelation(err)) {
        return { status: 'skipped', reason: 'org_connectors_missing' };
      }
      throw err;
    }

    if (rows.length === 0) {
      return { status: 'ok', disconnected: [], reason: 'no_connected_connectors' };
    }

    const nangoConfigured = isNangoSecretConfigured();
    const disconnected: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      const provider = String(row.connector_key);
      const result = await disconnectOneConnector(
        client,
        orgId,
        provider,
        actorUserId,
        nangoConfigured
      );
      if (result.error) {
        errors.push(`${provider}: ${result.error}`);
        continue;
      }
      disconnected.push(provider);
    }

    if (disconnected.length === 0 && errors.length > 0) {
      return {
        status: 'error',
        error: errors.slice(0, 5).join('; '),
        disconnected,
        nangoLocalOnly: !nangoConfigured,
      };
    }

    const reasonParts: string[] = [];
    if (!nangoConfigured) reasonParts.push('nango_unconfigured_local_disconnect');
    if (errors.length > 0) reasonParts.push(`partial_errors:${errors.length}`);

    return {
      status: 'ok',
      disconnected,
      nangoLocalOnly: !nangoConfigured,
      ...(reasonParts.length > 0 ? { reason: reasonParts.join(',') } : {}),
    };
  } finally {
    client.release();
  }
}

async function deleteMemoryTable(
  client: PoolClient,
  orgId: string,
  table: string
): Promise<{ table: string; count: number; skipped?: boolean }> {
  try {
    const res = await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    return { table, count: res.rowCount ?? 0 };
  } catch (err) {
    if (isMissingRelation(err)) {
      return { table, count: 0, skipped: true };
    }
    throw err;
  }
}

async function purgeMemory(
  orgId: string,
  actorUserId?: string | null
): Promise<OrgPurgeStepResult> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    const deleted: Record<string, number> = {};
    const skipped: string[] = [];

    for (const table of MEMORY_PURGE_TABLES) {
      const result = await deleteMemoryTable(client, orgId, table);
      if (result.skipped) {
        skipped.push(table);
        continue;
      }
      deleted[table] = result.count;
    }

    try {
      await recordAuditEvent(
        {
          orgId,
          kind: 'memory.delete',
          actor: actorUserId
            ? { actorType: 'user', userId: actorUserId }
            : { actorType: 'system', component: 'org-purge' },
          action: 'org.purge_memory',
          resultStatus: 'ok',
          riskClass: 'high',
          payload: { deleted, skipped, orgPurge: true },
        },
        { client, orgId }
      );
    } catch {
      // audit best-effort — soft_deleted already committed
    }

    return {
      status: 'ok',
      deleted,
      ...(skipped.length > 0 ? { reason: `tables_skipped:${skipped.join(',')}` } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', error: message.slice(0, 300) };
  } finally {
    client.release();
  }
}

/**
 * Run the three purge steps. Never throws for step failures — returns per-step
 * ok/skipped/error. Soft-delete status must already be committed before calling.
 */
export async function runOrgPurge(params: OrgPurgeParams): Promise<OrgPurgeResult> {
  const { orgId, actorUserId, source } = params;

  let temporal: OrgPurgeStepResult;
  try {
    temporal = await purgeTemporal(orgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    temporal = { status: 'error', error: message.slice(0, 300) };
  }

  let nango: OrgPurgeStepResult;
  try {
    nango = await purgeNango(orgId, actorUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    nango = { status: 'error', error: message.slice(0, 300) };
  }

  let memory: OrgPurgeStepResult;
  try {
    memory = await purgeMemory(orgId, actorUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    memory = { status: 'error', error: message.slice(0, 300) };
  }

  try {
    const { client } = await getOrgScopedClient(orgId);
    try {
      await recordAuditEvent(
        {
          orgId,
          kind: 'settings.update',
          actor: actorUserId
            ? { actorType: 'user', userId: actorUserId }
            : { actorType: 'system', component: 'org-purge' },
          action: 'settings.purge_completed',
          resultStatus:
            temporal.status === 'error' || nango.status === 'error' || memory.status === 'error'
              ? 'error'
              : 'ok',
          riskClass: 'high',
          payload: { source, temporal, nango, memory },
        },
        { client, orgId }
      );
    } catch {
      // best-effort
    } finally {
      client.release();
    }
  } catch {
    // ignore audit client failures
  }

  console.info(
    JSON.stringify({
      event: 'org_purge.completed',
      orgId,
      source,
      temporal: temporal.status,
      nango: nango.status,
      memory: memory.status,
    })
  );

  return { temporal, nango, memory };
}

/**
 * Fire-and-forget after soft-delete commit. Does not block the HTTP response.
 */
export function scheduleOrgPurge(params: OrgPurgeParams): void {
  void runOrgPurge(params)
    .then((result) => {
      console.info(
        JSON.stringify({
          event: 'org_purge.scheduled_done',
          orgId: params.orgId,
          source: params.source,
          result,
        })
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: 'org_purge.scheduled_failed',
          orgId: params.orgId,
          source: params.source,
          error: message.slice(0, 300),
        })
      );
    });
}
