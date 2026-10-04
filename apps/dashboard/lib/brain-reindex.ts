import type { PoolClient } from 'pg';
import { enqueueEmbedJob } from '@/lib/embed-enqueue';

export type ReindexSourceLookup =
  | { ok: true; connector: string; path: string; text: string }
  | { ok: false; skipped: 'missing' | 'empty' };

/**
 * Load text for a knowledge_sources row under the caller's scoped client.
 * Caller MUST release the client before calling enqueueReindexEmbed.
 */
export async function loadKnowledgeSourceForReindex(
  client: PoolClient,
  orgId: string,
  sourceId: string
): Promise<ReindexSourceLookup> {
  const src = await client.query<{
    id: string;
    connector: string;
    path: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT id, connector, path, metadata FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [sourceId, orgId]
  );
  const row = src.rows[0];
  if (!row) return { ok: false, skipped: 'missing' };

  // Text still waiting to embed lives on the newest queued job (208, MEM-B03);
  // older rows kept it in metadata.pendingText.
  const queued = await client.query<{ text: string | null }>(
    `SELECT payload->>'pendingText' AS text FROM ingestion_jobs
      WHERE org_id = $1 AND source_id = $2 AND payload ? 'pendingText'
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, sourceId]
  );
  const pending =
    queued.rows[0]?.text ??
    (row.metadata && typeof row.metadata.pendingText === 'string' ? row.metadata.pendingText : '');
  let text = pending.trim();
  if (!text) {
    const bodies = await client.query<{ body: string }>(
      `SELECT body FROM org_memory WHERE org_id = $1 AND source = $2 AND source_ref = $3
       UNION ALL
       SELECT body FROM conversation_memory WHERE org_id = $1 AND source = $2 AND source_ref = $3
       UNION ALL
       SELECT body FROM entity_memory WHERE org_id = $1 AND source = $2 AND source_ref = $3
       LIMIT 8`,
      [orgId, row.connector, row.path]
    );
    text = bodies.rows.map((r) => r.body).join('\n\n').trim();
  }
  if (!text) return { ok: false, skipped: 'empty' };
  return { ok: true, connector: row.connector, path: row.path, text };
}

/** Fire-and-forget embed after the DB client has been released. */
export async function enqueueReindexEmbed(
  orgId: string,
  lookup: Extract<ReindexSourceLookup, { ok: true }>
): Promise<{ enqueued: boolean; skipped?: string }> {
  const result = await enqueueEmbedJob({
    orgId,
    source: lookup.connector,
    sourceRef: lookup.path,
    text: lookup.text,
  });
  if (result.enqueued) return { enqueued: true };
  return { enqueued: false, skipped: result.skipReason };
}
