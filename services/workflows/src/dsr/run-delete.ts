import type { PoolClient } from 'pg';
import { deleteHindsightBank, hindsightEnabled } from '../memory/hindsight-client.js';
import { cogneeEnabled, deleteCogneeDataset } from '../memory/cognee-client.js';
import {
  DSR_DELETE_TABLES,
  markTableDone,
  parseDsrDeleteProgress,
  remainingDeleteTables,
  type DsrDeleteProgress,
} from './tables.js';

async function deleteIfExists(client: PoolClient, orgId: string, table: string): Promise<number> {
  try {
    const res = await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
    return res.rowCount ?? 0;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return 0;
    throw err;
  }
}

/** Tables in `tables` that still hold rows for the org (missing tables count as clean). */
export async function tablesWithRemainingRows(
  client: PoolClient,
  orgId: string,
  tables: readonly string[]
): Promise<Record<string, number>> {
  const leftover: Record<string, number> = {};
  for (const table of tables) {
    try {
      const res = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ${table} WHERE org_id = $1`,
        [orgId]
      );
      const n = Number(res.rows[0]?.n ?? 0);
      if (n > 0) leftover[table] = n;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === '42P01') continue;
      throw err;
    }
  }
  return leftover;
}

async function loadProgress(client: PoolClient, orgId: string, dsrRequestId: string): Promise<DsrDeleteProgress> {
  const res = await client.query<{ progress: unknown }>(
    `SELECT progress FROM dsr_requests WHERE id = $1 AND org_id = $2`,
    [dsrRequestId, orgId]
  );
  return parseDsrDeleteProgress(res.rows[0]?.progress);
}

async function saveProgress(
  client: PoolClient,
  orgId: string,
  dsrRequestId: string,
  progress: DsrDeleteProgress,
  status: 'running' | 'completed' | 'failed',
  error?: string
): Promise<void> {
  if (status === 'completed') {
    await client.query(
      `UPDATE dsr_requests
          SET status = 'completed',
              completed_at = NOW(),
              progress = $3::jsonb,
              result = $4::jsonb,
              error = NULL
        WHERE id = $1 AND org_id = $2`,
      [
        dsrRequestId,
        orgId,
        JSON.stringify(progress),
        JSON.stringify({ deleted: progress.deleted, includeVectors: true }),
      ]
    );
    return;
  }
  if (status === 'failed') {
    await client.query(
      `UPDATE dsr_requests
          SET status = 'failed',
              completed_at = NOW(),
              progress = $3::jsonb,
              error = $4
        WHERE id = $1 AND org_id = $2`,
      [dsrRequestId, orgId, JSON.stringify(progress), (error ?? 'delete failed').slice(0, 500)]
    );
    return;
  }
  await client.query(
    `UPDATE dsr_requests
        SET status = 'running',
            progress = $3::jsonb || jsonb_build_object('heartbeatAt', NOW()),
            completed_at = NULL,
            error = NULL
      WHERE id = $1 AND org_id = $2`,
    [dsrRequestId, orgId, JSON.stringify(progress)]
  );
}

async function writeDeleteAudit(
  client: PoolClient,
  orgId: string,
  userId: string | null,
  dsrRequestId: string,
  deleted: Record<string, number>
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_events (
         org_id, kind, actor_type, actor_user_id, result_status, payload
       ) VALUES ($1, 'dsr.delete', 'user', $2, 'ok', $3::jsonb)`,
      [
        orgId,
        userId,
        JSON.stringify({ dsrRequestId, deleted, includeVectors: true }),
      ]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/audit_events|kind_chk|does not exist/i.test(message)) {
      console.warn('[dsr] audit_events write skipped:', message.slice(0, 120));
      return;
    }
    throw err;
  }
}

export type RunDsrDeleteResult = {
  dsrRequestId: string;
  status: 'completed';
  deleted: Record<string, number>;
};

/**
 * Mark a DSR delete job failed after Temporal exhausts retries. Progress is
 * preserved so an operator can see how far the job got.
 */
export async function markDsrRequestFailed(
  client: PoolClient,
  params: { orgId: string; dsrRequestId: string; error: string }
): Promise<void> {
  const progress = await loadProgress(client, params.orgId, params.dsrRequestId);
  await saveProgress(
    client,
    params.orgId,
    params.dsrRequestId,
    progress,
    'failed',
    params.error
  );
}

/**
 * Resumable org delete. Persists doneTables after each table so a killed
 * request / Temporal activity retry continues from the cursor instead of
 * staying stuck in `running` with no resume point. Transient errors rethrow
 * while keeping status=running + progress; permanent failure is marked by
 * markDsrRequestFailed after retries are exhausted.
 */
export async function runDsrDelete(
  client: PoolClient,
  params: { orgId: string; dsrRequestId: string; requestedByUserId: string | null }
): Promise<RunDsrDeleteResult> {
  const { orgId, dsrRequestId, requestedByUserId } = params;
  let progress = await loadProgress(client, orgId, dsrRequestId);

  await saveProgress(client, orgId, dsrRequestId, { ...progress, currentTable: undefined }, 'running');

  const remaining = remainingDeleteTables(DSR_DELETE_TABLES, progress);
  for (const table of remaining) {
    progress = { ...progress, currentTable: table };
    await saveProgress(client, orgId, dsrRequestId, progress, 'running');

    const rowCount = await deleteIfExists(client, orgId, table);
    progress = markTableDone(progress, table, rowCount);
    await saveProgress(client, orgId, dsrRequestId, progress, 'running');
  }

  // Rows written mid-job (in-flight agent turns) would survive the per-table
  // DELETE; re-open those tables so the retry deletes them instead of
  // reporting a clean erasure that is not.
  const leftover = await tablesWithRemainingRows(client, orgId, DSR_DELETE_TABLES);
  const leftoverTables = Object.keys(leftover);
  if (leftoverTables.length > 0) {
    progress = {
      ...progress,
      doneTables: progress.doneTables.filter((t) => !leftoverTables.includes(t)),
    };
    await saveProgress(client, orgId, dsrRequestId, progress, 'running');
    throw new Error(
      `DSR delete verification found remaining rows: ${leftoverTables
        .map((t) => `${t}=${leftover[t]}`)
        .join(', ')}`
    );
  }

  // Hindsight holds extracted customer facts outside Postgres. A failure here
  // leaves the request `running` (Temporal retries) instead of reporting an
  // erasure that is not complete.
  if (hindsightEnabled()) {
    await deleteHindsightBank(orgId);
  }
  // Same for Cognee's per-org knowledge graph (dataset org_<uuid>).
  if (cogneeEnabled()) {
    await deleteCogneeDataset(orgId);
  }

  await saveProgress(client, orgId, dsrRequestId, progress, 'completed');
  await writeDeleteAudit(client, orgId, requestedByUserId, dsrRequestId, progress.deleted);

  return { dsrRequestId, status: 'completed', deleted: progress.deleted };
}
