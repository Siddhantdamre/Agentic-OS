import { createHash } from 'crypto';
import { getOrgScopedClient } from '@/lib/db';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';
import { redactForEmbed } from '@darex/workflows/dist/activities/redact';

export type EmbedSkipReason = 'hash' | 'kyc' | 'empty';

export type MemoryTierName = 'org' | 'employee' | 'entity' | 'conversation';

export type EnqueueEmbedJobInput = {
  orgId: string;
  source: string;
  sourceRef: string;
  text: string;
  kind?: string | null;
  dataClass?: string | null;
  /**
   * When set (brain correct/create), write the vector onto this memory row
   * in place after LiteLLM. Avoids sibling-row duplicates from EmbedWorkflow
   * insert-on-hash when the row already carries the new content_hash.
   */
  replaceMemory?: { tier: MemoryTierName; id: string };
};

export type EnqueueEmbedJobResult =
  | { enqueued: true; skipped: false; jobId: string }
  | { enqueued: false; skipped: true; skipReason: EmbedSkipReason; jobId?: string };

const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1536', 10);
const CHUNK_TARGET_CHARS = 1000;
const CHUNK_MAX_CHARS = 1400;

function hashEmbedContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Split for embed quality: prefer markdown headers, blank lines, then sentence
 * endings — never a blind mid-word slice unless a single unit exceeds the cap.
 */
export function chunkTextSentenceAware(
  text: string,
  targetChars = CHUNK_TARGET_CHARS,
  maxChars = CHUNK_MAX_CHARS
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= targetChars) return [normalized];

  const blocks = normalized.split(/\n{2,}|(?=^#{1,6}\s)/m).map((b) => b.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  const appendUnit = (unit: string) => {
    if (!unit) return;
    if (!current) {
      current = unit;
      return;
    }
    if (current.length + 1 + unit.length <= targetChars) {
      current = `${current}\n\n${unit}`;
      return;
    }
    pushCurrent();
    if (unit.length <= maxChars) {
      current = unit;
      return;
    }
    // Oversized unit: split on sentences, then hard-wrap as last resort.
    const sentences = unit.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [unit];
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s) continue;
      if (!current) {
        if (s.length <= maxChars) {
          current = s;
        } else {
          for (let i = 0; i < s.length; i += targetChars) {
            chunks.push(s.slice(i, i + targetChars));
          }
          current = '';
        }
        continue;
      }
      if (current.length + 1 + s.length <= targetChars) {
        current = `${current} ${s}`;
      } else {
        pushCurrent();
        if (s.length <= maxChars) current = s;
        else {
          for (let i = 0; i < s.length; i += targetChars) {
            chunks.push(s.slice(i, i + targetChars));
          }
          current = '';
        }
      }
    }
  };

  for (const block of blocks) appendUnit(block);
  pushCurrent();
  return chunks.length > 0 ? chunks : [normalized.slice(0, maxChars)];
}


function isAlreadyStarted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: string; message?: string };
  if (rec.name === 'WorkflowExecutionAlreadyStartedError') return true;
  return /already (started|running)/i.test(String(rec.message || ''));
}

function tableForTier(tier: MemoryTierName): string {
  switch (tier) {
    case 'org':
      return 'org_memory';
    case 'employee':
      return 'employee_memory';
    case 'entity':
      return 'entity_memory';
    case 'conversation':
      return 'conversation_memory';
    default: {
      const _exhaustive: never = tier;
      return _exhaustive;
    }
  }
}

function embeddingsUrl(): string {
  const base = (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  if (base.endsWith('/v1')) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
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

async function fetchEmbedding(text: string): Promise<number[] | null> {
  const model = process.env.EMBEDDING_MODEL;
  if (!model || !text.trim()) return null;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(embeddingsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text.slice(0, 8000),
        dimensions: EMBEDDING_DIM,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) return null;
    if (!vec.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return vec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed then UPDATE the existing memory row. Caller must not hold a pooled
 * client — this opens its own scoped client only after LiteLLM returns.
 */
async function reembedMemoryRowInPlace(params: {
  orgId: string;
  tier: MemoryTierName;
  memoryId: string;
  text: string;
  contentHash: string;
}): Promise<void> {
  const vec = await fetchEmbedding(params.text);
  if (!vec) {
    console.warn(
      `[embed-enqueue] in-place reembed skipped (no vector) for ${params.tier}:${params.memoryId}`
    );
    return;
  }
  const { client, orgId } = await getOrgScopedClient(params.orgId);
  try {
    const table = tableForTier(params.tier);
    await client.query(
      `UPDATE ${table}
          SET embedding = $1::vector,
              content_hash = $2,
              updated_at = NOW()
        WHERE id = $3 AND org_id = $4`,
      [`[${vec.join(',')}]`, params.contentHash, params.memoryId, orgId]
    );
  } finally {
    client.release();
  }
}

/**
 * Enqueue an embed job off the request thread. Inserts `knowledge_sources` +
 * `ingestion_jobs` under RLS, then fire-and-forget Temporal EmbedWorkflow.
 * With `replaceMemory`, updates that row's vector in place (no sibling insert).
 * Callers MUST NOT await the embedding itself on a webhook thread.
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

  const chunks = chunkTextSentenceAware(redacted.text);
  const primaryText = chunks[0] || redacted.text;
  const contentHash = hashEmbedContent(primaryText);

  if (input.replaceMemory) {
    const { tier, id } = input.replaceMemory;
    const jobId = `inplace-${tier}-${id}`;
    void reembedMemoryRowInPlace({
      orgId: input.orgId,
      tier,
      memoryId: id,
      text: primaryText,
      contentHash: hashEmbedContent(redacted.text),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[embed-enqueue] in-place reembed failed for ${jobId}: ${message}`);
    });
    return { enqueued: true, skipped: false, jobId };
  }

  const { client, orgId } = await getOrgScopedClient(input.orgId);
  let result: EnqueueEmbedJobResult;
  const extraJobs: string[] = [];
  try {
    // Only skip when a fully-embedded row already matches — NULL embedding
    // means a correct/create is waiting for a vector and must not short-circuit.
    const existing = await client.query(
      `SELECT id FROM org_memory
        WHERE org_id = $1 AND source = $2 AND source_ref = $3 AND content_hash = $4
          AND embedding IS NOT NULL
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
            pendingText: primaryText,
            source,
            sourceRef,
            kind: input.kind ?? null,
            dataClass: input.dataClass ?? null,
            chunkIndex: 0,
            chunkCount: chunks.length,
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

      for (let i = 1; i < chunks.length; i += 1) {
        const chunkRef = `${sourceRef}#chunk-${i}`;
        const chunkHash = hashEmbedContent(chunks[i]);
        const chunkSource = await client.query(
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
            chunkRef,
            chunkHash,
            JSON.stringify({
              pendingText: chunks[i],
              source,
              sourceRef: chunkRef,
              kind: input.kind ?? null,
              dataClass: input.dataClass ?? null,
              chunkIndex: i,
              chunkCount: chunks.length,
            }),
          ]
        );
        const chunkJob = await client.query(
          `INSERT INTO ingestion_jobs (org_id, source_id, state, cursor)
           VALUES ($1, $2, 'queued', $3)
           RETURNING id`,
          [orgId, chunkSource.rows[0].id, chunkHash]
        );
        extraJobs.push(chunkJob.rows[0].id as string);
      }
    }
  } finally {
    client.release();
  }

  if (result.enqueued) {
    await startEmbedWorkflowFireAndForget(orgId, result.jobId);
    for (const jobId of extraJobs) {
      await startEmbedWorkflowFireAndForget(orgId, jobId);
    }
  }
  return result;
}
