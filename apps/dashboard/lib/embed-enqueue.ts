import { createHash } from 'crypto';
import { getOrgScopedClient } from '@/lib/db';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';
import { redactForEmbed } from '@darex/workflows/dist/activities/redact';

export type EmbedSkipReason = 'hash' | 'kyc' | 'empty';

export type EnqueueEmbedJobInput = {
  orgId: string;
  source: string;
  sourceRef: string;
  text: string;
  kind?: string | null;
  dataClass?: string | null;
};

export type EnqueueEmbedJobResult =
  | { enqueued: true; skipped: false; jobId: string }
  | { enqueued: false; skipped: true; skipReason: EmbedSkipReason; jobId?: string };

function hashEmbedContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isAlreadyStarted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: string; message?: string };
  if (rec.name === 'WorkflowExecutionAlreadyStartedError') return true;
  return /already (started|running)/i.test(String(rec.message || ''));
}

/**
 * Start EmbedWorkflow without waiting for the embedding to finish.
 * Must never be awaited for completion on a webhook thread.
 */
async function startEmbedWorkflowFireAndForget(orgId: string, jobId: string): Promise<void> {
  const client = await getTemporalClient();
  if (!client) return;
  const workflowId = `embed-${orgId}-${jobId}`;
  try {
    await client.workflow.start('EmbedWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ orgId, jobId }],
      workflowExecutionTimeout: '30 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[embed-enqueue] EmbedWorkflow start failed for ${workflowId}: ${message}`);
  }
}

/**
 * Enqueue an embed job off the request thread. Inserts `knowledge_sources` +
 * `ingestion_jobs` under RLS, then fire-and-forget Temporal EmbedWorkflow.
 * Callers MUST NOT await the embedding itself — this function does not call LiteLLM.
 *
 * `orgId` must come from a trusted session / webhook resolver, never from a request body.
 */
export async function enqueueEmbedJob(input: EnqueueEmbedJobInput): Promise<EnqueueEmbedJobResult> {
  if (!input.orgId) {
    throw new Error('orgId is required');
  }

  const source = (input.source || 'upload').trim() || 'upload';
  const sourceRef = (input.sourceRef || '').trim() || 'inline';
  const redacted = redactForEmbed(input.text, { kind: input.kind, dataClass: input.dataClass });

  if (redacted.skipped && redacted.reason) {
    const reason = redacted.reason;
    switch (reason) {
      case 'kyc':
      case 'empty':
        return { enqueued: false, skipped: true, skipReason: reason };
      default: {
        const _exhaustive: never = reason;
        return _exhaustive;
      }
    }
  }

  const contentHash = hashEmbedContent(redacted.text);
  const { client, orgId } = await getOrgScopedClient(input.orgId);
  let result: EnqueueEmbedJobResult;
  try {
    const existing = await client.query(
      `SELECT id FROM org_memory
        WHERE org_id = $1 AND source = $2 AND source_ref = $3 AND content_hash = $4
        LIMIT 1`,
      [orgId, source, sourceRef, contentHash]
    );
    if (existing.rows[0]?.id) {
      result = { enqueued: false, skipped: true, skipReason: 'hash' };
    } else {
      const sourceRow = await client.query(
        `INSERT INTO knowledge_sources (org_id, connector, path, content_hash, status, metadata)
         VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
         ON CONFLICT (org_id, connector, path)
         DO UPDATE SET
           metadata = knowledge_sources.metadata || EXCLUDED.metadata,
           status = 'pending',
           updated_at = NOW()
         RETURNING id`,
        [
          orgId,
          source,
          sourceRef,
          contentHash,
          JSON.stringify({
            pendingText: redacted.text,
            source,
            sourceRef,
            kind: input.kind ?? null,
            dataClass: input.dataClass ?? null,
          }),
        ]
      );
      const jobRow = await client.query(
        `INSERT INTO ingestion_jobs (org_id, source_id, state, cursor)
         VALUES ($1, $2, 'queued', $3)
         RETURNING id`,
        [orgId, sourceRow.rows[0].id, contentHash]
      );
      result = { enqueued: true, skipped: false, jobId: jobRow.rows[0].id as string };
    }
  } finally {
    client.release();
  }

  if (result.enqueued) {
    await startEmbedWorkflowFireAndForget(orgId, result.jobId);
  }
  return result;
}
