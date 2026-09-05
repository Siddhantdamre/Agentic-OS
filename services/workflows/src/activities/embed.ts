import { createHash } from 'crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { Pool, PoolClient } from 'pg';
import type { IngestionJobState, MemorySourceKind, OrgMemoryKind } from '@darex/shared-types';
import { MEMORY_SOURCE_KINDS } from '@darex/shared-types';
import { getTemporalClient } from '../workflow-client.js';
import { redactErrorMessage, redactForEmbed } from './redact.js';

/** Must match `infra/db/migrations/013_memory_rag.sql` (`vector(1536)`). */
export const SCHEMA_EMBEDDING_DIM = 1536;
const EMBED_BATCH_SIZE = 64;
const MAX_EMBED_CHARS = 32000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * A SPENT DAILY QUOTA IS NOT A THROTTLE, AND RETRYING IT IS PURE WASTE.
 *
 * Both arrive as HTTP 429, and the difference decides whether backing off is
 * clever or pointless. A per-minute rate limit clears in seconds. A daily quota
 * does not clear today, so every retry against it is a request that CANNOT
 * succeed - and there are three retry layers stacked here: this function's own
 * loop, Temporal's maximumAttempts of 5, and LiteLLM's internal 2. They
 * multiply.
 *
 * Measured in one 15-minute window with the Gemini embedding quota spent:
 *
 *   732 RateLimitError    <- of which 212 name text-embedding-3-small
 *   275 geminiException
 *
 * That traffic is not free. It occupies the same worker and router that
 * customer replies go through, and agent turns in that window took four
 * minutes.
 *
 * Gemini says "You exceeded your current quota, please check your plan and
 * billing details" for exhaustion and something else for a throttle, so the
 * body is the signal. Anything ambiguous stays retryable: a throttle wrongly
 * treated as exhaustion loses work that a two-second wait would have saved.
 */
export function isQuotaExhausted(body: string): boolean {
  return /exceeded\s+your\s+current\s+quota|check\s+your\s+plan\s+and\s+billing|insufficient[_\s]quota|quota[_\s]exceeded/i
    .test(body || '');
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
  max: 5,
});

export type EmbedSkipReason = 'hash' | 'kyc' | 'empty';
export type EmbedJobStatus = 'embedded' | 'skipped' | 'failed';

export interface EmbedJobResult {
  status: EmbedJobStatus;
  skipReason?: EmbedSkipReason;
  memoryId?: string;
  processed?: number;
  error?: string;
}

export interface PersistEmbedJobParams {
  orgId: string;
  source: string;
  sourceRef: string;
  text: string;
  kind?: string | null;
  dataClass?: string | null;
}

export type PersistEmbedJobResult =
  | { enqueued: true; skipped: false; jobId: string }
  | { enqueued: false; skipped: true; skipReason: EmbedSkipReason; jobId?: string };

type MemoryWriteTarget =
  | { tier: 'org' }
  | { tier: 'conversation'; conversationId: string };

interface PendingEmbedPayload {
  pendingText: string;
  source: MemorySourceKind;
  sourceRef: string;
  kind?: string | null;
  dataClass?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hashEmbedContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isBlank(value: string | undefined | null): boolean {
  return !value || !value.trim();
}

/**
 * Production fail-fast for the Temporal worker process. Webhooks must not
 * call this — unset EMBEDDING_MODEL must not fail inbound HTTP.
 */
export function assertEmbeddingWorkerConfig(): void {
  if (!isProductionEnv()) return;

  // EXPLICITLY EMPTY means "embeddings are deliberately disabled" — a supported
  // configuration, not a misconfiguration. Memory/RAG is optional enrichment;
  // the product must run without it. UNSET still fails, because that is someone
  // forgetting to configure rather than choosing to switch it off.
  //
  // Without this distinction the worker crash-looped on `EMBEDDING_MODEL=`,
  // which is the only way to disable a provider you have no key for.
  if (process.env.EMBEDDING_MODEL === '') return;

  if (isBlank(process.env.EMBEDDING_MODEL)) {
    throw new Error(
      'EMBEDDING_MODEL must be set in production (use EMBEDDING_MODEL= to disable embeddings deliberately).'
    );
  }
  if (isBlank(process.env.EMBEDDING_DIM)) {
    throw new Error('EMBEDDING_DIM must be set in production and must equal 1536 (migration 013).');
  }
  if (isBlank(process.env.LITELLM_BASE_URL)) {
    throw new Error('LITELLM_BASE_URL must be set in production for LiteLLM embeddings.');
  }
  const dim = parseInt(process.env.EMBEDDING_DIM, 10);
  if (dim !== SCHEMA_EMBEDDING_DIM) {
    throw new Error(
      `EMBEDDING_DIM=${dim} does not match schema vector(${SCHEMA_EMBEDDING_DIM}). Do not mix dims.`
    );
  }
}

function requireEmbeddingModel(): string {
  const model = process.env.EMBEDDING_MODEL?.trim();
  if (!model) {
    throw ApplicationFailure.nonRetryable(
      'EMBEDDING_MODEL must be set (env-only; no vendor default in app code)',
      'ConfigurationError'
    );
  }
  return model;
}

function requireEmbeddingDim(): number {
  const raw = process.env.EMBEDDING_DIM;
  if (isBlank(raw)) {
    throw ApplicationFailure.nonRetryable(
      'EMBEDDING_DIM must be set and must equal 1536 (migration 013)',
      'ConfigurationError'
    );
  }
  const dim = parseInt(raw as string, 10);
  if (dim !== SCHEMA_EMBEDDING_DIM) {
    throw ApplicationFailure.nonRetryable(
      `EMBEDDING_DIM=${dim} does not match schema vector(${SCHEMA_EMBEDDING_DIM})`,
      'EmbeddingDimMismatch'
    );
  }
  return dim;
}

function resolveLiteLLMEmbeddingsConfig(): { baseUrl: string; apiKey: string; model: string } {
  const isProd = isProductionEnv();
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!rawBase) {
    throw ApplicationFailure.nonRetryable('LITELLM_BASE_URL must be set', 'ConfigurationError');
  }
  if (!apiKey) {
    throw ApplicationFailure.nonRetryable(
      'LITELLM_API_KEY or LITELLM_MASTER_KEY must be set',
      'ConfigurationError'
    );
  }
  const trimmed = rawBase.replace(/\/+$/, '');
  const baseUrl = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  return { baseUrl, apiKey, model: requireEmbeddingModel() };
}

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // always release
    }
    client.release();
  }
}

function isMemorySourceKind(value: string): value is MemorySourceKind {
  return (MEMORY_SOURCE_KINDS as readonly string[]).includes(value);
}

export function resolveMemorySourceKind(source: string): MemorySourceKind {
  if (isMemorySourceKind(source)) return source;
  switch (source) {
    case 'chatwoot':
    case 'inbox':
    case 'ask_ai':
    case 'unknown':
      return 'conversation';
    default:
      return 'upload';
  }
}

function orgMemoryKindFor(source: MemorySourceKind): OrgMemoryKind {
  switch (source) {
    case 'drive':
    case 'notion':
    case 'upload':
    case 'pack':
    case 'crawl':
      return 'sop';
    case 'gmail':
    case 'whatsapp':
    case 'slack':
    case 'conversation':
      return 'summary';
    case 'sheets':
    case 'crm':
    case 'tool':
      return 'fact';
    case 'human':
      return 'note';
    case 'web':
    case 'public_official':
      return 'policy';
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function assertJobState(state: IngestionJobState): IngestionJobState {
  switch (state) {
    case 'queued':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return state;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function skipCursor(reason: EmbedSkipReason): string {
  switch (reason) {
    case 'hash':
      return 'skipped:hash';
    case 'kyc':
      return 'skipped:kyc';
    case 'empty':
      return 'skipped:empty';
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

function titleFromBody(body: string): string {
  const line = body.split('\n').find((part) => part.trim());
  return (line || 'memory').trim().slice(0, 120);
}

function isAlreadyStarted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: string; message?: string };
  if (rec.name === 'WorkflowExecutionAlreadyStartedError') return true;
  return /already (started|running)/i.test(String(rec.message || ''));
}

export async function startEmbedWorkflowFireAndForget(input: {
  orgId: string;
  jobId: string;
}): Promise<void> {
  const client = await getTemporalClient();
  if (!client) return;
  const workflowId = `embed-${input.orgId}-${input.jobId}`;
  try {
    await client.workflow.start('EmbedWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ orgId: input.orgId, jobId: input.jobId }],
      workflowExecutionTimeout: '30 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[embed] EmbedWorkflow start failed for ${workflowId}: ${message}`);
  }
}

async function findExistingMemoryId(
  client: PoolClient,
  params: { orgId: string; source: string; sourceRef: string; contentHash: string; target: MemoryWriteTarget }
): Promise<string | null> {
  switch (params.target.tier) {
    case 'conversation': {
      const res = await client.query(
        `SELECT id FROM conversation_memory
          WHERE org_id = $1 AND source = $2 AND source_ref = $3 AND content_hash = $4
          LIMIT 1`,
        [params.orgId, params.source, params.sourceRef, params.contentHash]
      );
      return (res.rows[0]?.id as string) || null;
    }
    case 'org': {
      const res = await client.query(
        `SELECT id FROM org_memory
          WHERE org_id = $1 AND source = $2 AND source_ref = $3 AND content_hash = $4
          LIMIT 1`,
        [params.orgId, params.source, params.sourceRef, params.contentHash]
      );
      return (res.rows[0]?.id as string) || null;
    }
    default: {
      const _exhaustive: never = params.target;
      return _exhaustive;
    }
  }
}

async function resolveWriteTarget(
  client: PoolClient,
  orgId: string,
  source: MemorySourceKind,
  sourceRef: string
): Promise<MemoryWriteTarget> {
  switch (source) {
    case 'whatsapp':
    case 'conversation':
    case 'slack':
    case 'gmail': {
      if (UUID_RE.test(sourceRef)) {
        const res = await client.query(
          `SELECT id FROM conversations WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [sourceRef, orgId]
        );
        if (res.rows[0]?.id) {
          return { tier: 'conversation', conversationId: res.rows[0].id as string };
        }
      }
      return { tier: 'org' };
    }
    case 'drive':
    case 'notion':
    case 'upload':
    case 'pack':
    case 'crawl':
    case 'sheets':
    case 'crm':
    case 'tool':
    case 'human':
    case 'web':
    case 'public_official':
      return { tier: 'org' };
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

async function insertMemoryRow(
  client: PoolClient,
  params: {
    orgId: string;
    source: MemorySourceKind;
    sourceRef: string;
    body: string;
    contentHash: string;
    embedding: number[];
    target: MemoryWriteTarget;
    metadata: Record<string, unknown>;
  }
): Promise<string> {
  const kind = orgMemoryKindFor(params.source);
  const title = titleFromBody(params.body);
  // An empty array means "no embedding available" (embeddings unconfigured).
  // vectorLiteral([]) produces "[]", and '[]'::vector fails on a dimension
  // mismatch against vector(1536). NULL is the correct representation, and the
  // column is nullable precisely for this case.
  const embedding = params.embedding.length ? vectorLiteral(params.embedding) : null;

  switch (params.target.tier) {
    case 'conversation': {
      const res = await client.query(
        `INSERT INTO conversation_memory (
           org_id, conversation_id, kind, title, summary, body, embedding,
           source, source_ref, content_hash, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11::jsonb)
         ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING
         RETURNING id`,
        [
          params.orgId,
          params.target.conversationId,
          kind,
          title,
          params.body.slice(0, 2000),
          params.body,
          embedding,
          params.source,
          params.sourceRef,
          params.contentHash,
          JSON.stringify(params.metadata),
        ]
      );
      if (res.rows[0]?.id) return res.rows[0].id as string;
      const existing = await findExistingMemoryId(client, {
        orgId: params.orgId,
        source: params.source,
        sourceRef: params.sourceRef,
        contentHash: params.contentHash,
        target: params.target,
      });
      if (!existing) {
        throw new Error('conversation_memory upsert conflict but no existing row');
      }
      return existing;
    }
    case 'org': {
      const res = await client.query(
        `INSERT INTO org_memory (
           org_id, kind, title, body, embedding, source, source_ref, content_hash, metadata
         ) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9::jsonb)
         ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING
         RETURNING id`,
        [
          params.orgId,
          kind,
          title,
          params.body,
          embedding,
          params.source,
          params.sourceRef,
          params.contentHash,
          JSON.stringify(params.metadata),
        ]
      );
      if (res.rows[0]?.id) return res.rows[0].id as string;
      const existing = await findExistingMemoryId(client, {
        orgId: params.orgId,
        source: params.source,
        sourceRef: params.sourceRef,
        contentHash: params.contentHash,
        target: params.target,
      });
      if (!existing) {
        throw new Error('org_memory upsert conflict but no existing row');
      }
      return existing;
    }
    default: {
      const _exhaustive: never = params.target;
      return _exhaustive;
    }
  }
}

async function markJob(
  client: PoolClient,
  params: {
    orgId: string;
    jobId: string;
    sourceId?: string;
    state: IngestionJobState;
    cursor?: string | null;
    error?: string | null;
    contentHash?: string | null;
  }
): Promise<void> {
  const state = assertJobState(params.state);
  const finished = state === 'succeeded' || state === 'failed' || state === 'cancelled';
  await client.query(
    `UPDATE ingestion_jobs
        SET state = $1,
            cursor = COALESCE($2, cursor),
            error = $3,
            finished_at = CASE WHEN $4 THEN NOW() ELSE finished_at END,
            started_at = COALESCE(started_at, NOW())
      WHERE id = $5 AND org_id = $6`,
    [state, params.cursor ?? null, params.error ?? null, finished, params.jobId, params.orgId]
  );
  if (params.sourceId) {
    const sourceStatus = state === 'succeeded' ? 'ready' : state === 'failed' ? 'error' : 'syncing';
    await client.query(
      `UPDATE knowledge_sources
          SET status = $1,
              content_hash = COALESCE($2, content_hash),
              last_synced = CASE WHEN $3 THEN NOW() ELSE last_synced END,
              metadata = metadata - 'pendingText'
        WHERE id = $4 AND org_id = $5`,
      [sourceStatus, params.contentHash ?? null, state === 'succeeded', params.sourceId, params.orgId]
    );
  }
}

/**
 * Is an embeddings provider actually usable?
 *
 * Checked BEFORE calling LiteLLM so an unconfigured deployment never issues a
 * request that is certain to 500. Memory/RAG is optional enrichment; replies
 * are the product, and an optional capability must not be able to break a
 * required one. Callers treat `false` as "skip memory, continue the turn".
 */
export function isEmbeddingsConfigured(): boolean {
  const model = process.env.EMBEDDING_MODEL?.trim();
  const base = process.env.LITELLM_BASE_URL?.trim();
  const key = (process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '').trim();
  return Boolean(model && base && key);
}

/** Thrown when embeddings are deliberately skipped. Never a workflow failure. */
export class EmbeddingsUnconfiguredError extends Error {
  readonly skipped = true;
  constructor() {
    super('memory_embeddings_skipped_unconfigured');
    this.name = 'EmbeddingsUnconfiguredError';
  }
}

/**
 * A VENDOR OUTAGE DEGRADES SEARCH. IT DOES NOT DISCARD THE DOCUMENT.
 *
 * Retrieval is hybrid - tsvector keyword AND cosine similarity - and it already
 * handles a missing vector: `WHEN em.embedding IS NULL THEN 0::float8`, with
 * the keyword half carrying the query on its own. `org_memory.embedding` is
 * nullable, 858 of the 1227 rows in this database have no vector, and
 * `backfill-embeddings.js` exists to fill them in later.
 *
 * Every layer was built for this except ingestion, which computed the vectors
 * BEFORE writing any row. So when the embedding provider was out, the throw
 * happened first and nothing was stored at all - the customer's uploaded file
 * simply never became knowledge, on a schema where it could have been keyword
 * searchable immediately. Measured: uploads failed the gate with "landed in
 * org_memory — not found within 60s" while Gemini answered
 *
 *   429 You exceeded your current quota
 *
 * to every embedding call.
 *
 * Degrading on ANY embedding failure rather than only on quota exhaustion is
 * deliberate. The distinction matters for whether to RETRY; it does not matter
 * for whether to keep the document, and losing it is the worse outcome in
 * every case.
 *
 * NOTE what is deliberately not done here: fall back to a different embedding
 * provider. Vectors from another model live in a different space and are not
 * comparable to the ones already indexed, so a "failover tier" would leave
 * cosine similarity quietly returning nonsense. Chat can fail over between
 * vendors; an embedding index cannot, unless every row is re-embedded together.
 */
async function createEmbeddingsOrDegrade(texts: string[]): Promise<number[][]> {
  try {
    return await createEmbeddings(texts);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[embed] storing ${texts.length} row(s) without vectors — search degrades to `
      + `keyword until backfill-embeddings.js runs: ${redactErrorMessage(message).slice(0, 200)}`
    );
    // An empty array is written as SQL NULL by the insert, which is what the
    // backfill query looks for.
    return texts.map(() => []);
  }
}

async function createEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Do not attempt a call that cannot succeed — this is what stops an
  // unconfigured provider from consuming worker slots on guaranteed failures.
  if (!isEmbeddingsConfigured()) throw new EmbeddingsUnconfiguredError();
  const dim = requireEmbeddingDim();
  const { baseUrl, apiKey, model } = resolveLiteLLMEmbeddingsConfig();
  const out: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE).map((text) => text.slice(0, MAX_EMBED_CHARS));
    const vectors = await embedBatchWithRetry(`${baseUrl}/embeddings`, apiKey, model, batch);
    for (const vector of vectors) {
      if (vector.length !== dim) {
        throw ApplicationFailure.nonRetryable(
          `Embedding length ${vector.length} != EMBEDDING_DIM ${dim}`,
          'EmbeddingDimMismatch'
        );
      }
      out.push(vector);
    }
  }
  return out;
}

async function embedBatchWithRetry(
  url: string,
  apiKey: string,
  model: string,
  input: string[]
): Promise<number[][]> {
  // ONE attempt, short timeout. Memory is an OPTIONAL enrichment and must never
  // be able to take down replies, which are the product.
  //
  // Previously 5 retries x 120s. With embeddings misconfigured (LiteLLM 500
  // "Missing Gemini API key") every inbound message burned ~44s+ per attempt
  // and retried, exhausting the worker's activity slots so agent turns were
  // never scheduled and replies stopped entirely — an optional capability took
  // down a required one. Failing fast releases the slot immediately; the caller
  // records the failure and continues without memory.
  const maxRetries = 0;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // `dimensions` truncates the vendor's native output to the app's
        // schema width (vector(1536), see SCHEMA_EMBEDDING_DIM above) — the
        // OpenAI-compatible param LiteLLM forwards to providers that support
        // Matryoshka truncation (OpenAI text-embedding-3-*, Gemini).
        body: JSON.stringify({ model, input, dimensions: SCHEMA_EMBEDDING_DIM }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        const rows = Array.isArray(data?.data) ? [...data.data] : [];
        rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== input.length) {
          throw new Error(`LiteLLM embeddings returned ${rows.length} vectors for ${input.length} inputs`);
        }
        return rows.map((row) => {
          if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
            throw new Error('LiteLLM embeddings response missing embedding vector');
          }
          return row.embedding;
        });
      }

      const body = await res.text().catch(() => '');
      const err = new Error(`LiteLLM embeddings HTTP ${res.status}: ${body.slice(0, 300)}`);
      // Checked BEFORE the retryable-status test, because 429 is in that set
      // and an exhausted quota is the one 429 that will not clear by waiting.
      if (res.status === 429 && isQuotaExhausted(body)) {
        throw ApplicationFailure.nonRetryable(err.message, 'QuotaExhausted');
      }
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
        if (res.status === 401 || res.status === 403) {
          throw ApplicationFailure.nonRetryable(err.message, 'AuthorizationError');
        }
        throw err;
      }
      lastError = err;
    } catch (err: unknown) {
      controller.abort();
      const rec = err as { name?: string; message?: string };
      if (rec?.name === 'AbortError') {
        throw new Error('LiteLLM embeddings timed out after 120000ms');
      }
      if (err instanceof ApplicationFailure) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= maxRetries) break;
    } finally {
      clearTimeout(timeout);
    }

    const backoff = Math.min(30000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  throw lastError ?? new Error('LiteLLM embeddings request failed');
}

function readPendingPayload(metadata: unknown, fallback: PendingEmbedPayload): PendingEmbedPayload {
  if (!metadata || typeof metadata !== 'object') return fallback;
  const rec = metadata as Record<string, unknown>;
  const pendingText = typeof rec.pendingText === 'string' ? rec.pendingText : fallback.pendingText;
  const sourceRaw = typeof rec.source === 'string' ? rec.source : fallback.source;
  const sourceRef = typeof rec.sourceRef === 'string' ? rec.sourceRef : fallback.sourceRef;
  return {
    pendingText,
    source: resolveMemorySourceKind(sourceRaw),
    sourceRef,
    kind: typeof rec.kind === 'string' ? rec.kind : fallback.kind,
    dataClass: typeof rec.dataClass === 'string' ? rec.dataClass : fallback.dataClass,
  };
}

async function persistEmbedJobWithClient(
  client: PoolClient,
  params: PersistEmbedJobParams
): Promise<PersistEmbedJobResult> {
  const source = resolveMemorySourceKind(params.source);
  const sourceRef = (params.sourceRef || '').trim() || 'inline';
  const redacted = redactForEmbed(params.text, { kind: params.kind, dataClass: params.dataClass });

  if (redacted.skipped && redacted.reason) {
    return { enqueued: false, skipped: true, skipReason: redacted.reason };
  }

  const contentHash = hashEmbedContent(redacted.text);
  const target = await resolveWriteTarget(client, params.orgId, source, sourceRef);
  const existing = await findExistingMemoryId(client, {
    orgId: params.orgId,
    source,
    sourceRef,
    contentHash,
    target,
  });
  if (existing) {
    return { enqueued: false, skipped: true, skipReason: 'hash' };
  }

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
      params.orgId,
      source,
      sourceRef,
      contentHash,
      JSON.stringify({
        pendingText: redacted.text,
        source,
        sourceRef,
        kind: params.kind ?? null,
        dataClass: params.dataClass ?? null,
      }),
    ]
  );
  const sourceId = sourceRow.rows[0].id as string;

  const jobRow = await client.query(
    `INSERT INTO ingestion_jobs (org_id, source_id, state, cursor)
     VALUES ($1, $2, 'queued', $3)
     RETURNING id`,
    [params.orgId, sourceId, contentHash]
  );

  return { enqueued: true, skipped: false, jobId: jobRow.rows[0].id as string };
}

/**
 * Worker-side enqueue: persist a queued job under RLS, then start EmbedWorkflow
 * without waiting for the embedding to finish.
 */
export async function enqueueEmbedJobFromWorker(
  params: PersistEmbedJobParams
): Promise<PersistEmbedJobResult> {
  // Embeddings switched off: do not spawn EmbedWorkflow — a workflow whose only
  // activity is guaranteed to fail wastes worker slots on every inbound
  // message, and that starvation is what stopped agent replies.
  //
  // But DO still persist the text. Returning a bare no-op here meant every
  // ingestion path — uploads, Drive, Sheets, HubSpot — silently landed nothing,
  // because org_memory is written only from this pipeline. Uploads reported
  // success and the knowledge base stayed empty.
  //
  // Embeddings are an enhancement, not a prerequisite: retrieval ranks on
  // `body_tsv` full-text and only ADDS vector similarity when an embedding
  // exists (retrieve.ts guards that arm with `om.embedding IS NOT NULL`).
  // `org_memory.embedding` is nullable, so text stored now is findable now and
  // can be embedded later. Losing the text is permanent; lacking a vector is not.
  if (!isEmbeddingsConfigured()) {
    try {
      const redacted = redactForEmbed(params.text, {
        kind: params.kind,
        dataClass: params.dataClass,
      });
      if (redacted.skipped) {
        return { enqueued: false, noOp: true, jobId: null, skipped: redacted.reason } as any;
      }
      const contentHash = hashEmbedContent(redacted.text);
      const memoryId = await withOrgClient(params.orgId, (client) =>
        insertMemoryRow(client, {
          orgId: params.orgId,
          source: params.source as any,
          sourceRef: params.sourceRef,
          body: redacted.text,
          contentHash,
          // No vector. NULL::vector is valid; retrieval falls back to full-text,
          // which is how every seeded document is already found today.
          embedding: [],
          target: { tier: 'org' },
          metadata: { embedded: false, reason: 'embeddings_unconfigured' },
        })
      );
      return { enqueued: false, noOp: true, jobId: null, memoryId, storedWithoutEmbedding: true } as any;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Never fail the caller's ingest over this — report and move on.
      console.error('[embed] direct org_memory write failed:', message);
      return { enqueued: false, noOp: true, jobId: null, skipped: 'memory_write_failed' } as any;
    }
  }

  const result = await withOrgClient(params.orgId, (client) => persistEmbedJobWithClient(client, params));
  if (result.enqueued) {
    await startEmbedWorkflowFireAndForget({ orgId: params.orgId, jobId: result.jobId });
  }
  return result;
}

async function processLoadedJob(params: {
  orgId: string;
  jobId: string;
  sourceId: string;
  payload: PendingEmbedPayload;
}): Promise<EmbedJobResult> {
  const redacted = redactForEmbed(params.payload.pendingText, {
    kind: params.payload.kind,
    dataClass: params.payload.dataClass,
  });
  if (redacted.skipped && redacted.reason) {
    await withOrgClient(params.orgId, (client) =>
      markJob(client, {
        orgId: params.orgId,
        jobId: params.jobId,
        sourceId: params.sourceId,
        state: 'succeeded',
        cursor: skipCursor(redacted.reason as EmbedSkipReason),
        error: null,
      })
    );
    return { status: 'skipped', skipReason: redacted.reason, processed: 1 };
  }

  const contentHash = hashEmbedContent(redacted.text);
  const pre = await withOrgClient(params.orgId, async (client) => {
    const target = await resolveWriteTarget(client, params.orgId, params.payload.source, params.payload.sourceRef);
    const existingId = await findExistingMemoryId(client, {
      orgId: params.orgId,
      source: params.payload.source,
      sourceRef: params.payload.sourceRef,
      contentHash,
      target,
    });
    return { target, existingId };
  });

  if (pre.existingId) {
    await withOrgClient(params.orgId, (client) =>
      markJob(client, {
        orgId: params.orgId,
        jobId: params.jobId,
        sourceId: params.sourceId,
        state: 'succeeded',
        cursor: skipCursor('hash'),
        error: null,
        contentHash,
      })
    );
    return { status: 'skipped', skipReason: 'hash', memoryId: pre.existingId, processed: 1 };
  }

  const [embedding] = await createEmbeddingsOrDegrade([redacted.text]);

  const memoryId = await withOrgClient(params.orgId, async (client) => {
    const id = await insertMemoryRow(client, {
      orgId: params.orgId,
      source: params.payload.source,
      sourceRef: params.payload.sourceRef,
      body: redacted.text,
      contentHash,
      embedding,
      target: pre.target,
      metadata: {
        ingestionJobId: params.jobId,
        knowledgeSourceId: params.sourceId,
        embeddingDim: SCHEMA_EMBEDDING_DIM,
      },
    });
    await markJob(client, {
      orgId: params.orgId,
      jobId: params.jobId,
      sourceId: params.sourceId,
      state: 'succeeded',
      cursor: contentHash,
      error: null,
      contentHash,
    });
    return id;
  });

  return { status: 'embedded', memoryId, processed: 1 };
}

export async function embedIngestionJobActivity(params: {
  orgId: string;
  jobId: string;
}): Promise<EmbedJobResult> {
  if (!params.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  if (!params.jobId) {
    throw ApplicationFailure.nonRetryable('jobId is required', 'InvalidArgumentError');
  }

  const loaded = await withOrgClient(params.orgId, async (client) => {
    const claimed = await client.query(
      `UPDATE ingestion_jobs
          SET state = 'running', started_at = COALESCE(started_at, NOW())
        WHERE id = $1 AND org_id = $2 AND state IN ('queued', 'running')
        RETURNING id, source_id, state, cursor`,
      [params.jobId, params.orgId]
    );
    if (claimed.rows.length === 0) {
      const existing = await client.query(
        `SELECT id, source_id, state FROM ingestion_jobs WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [params.jobId, params.orgId]
      );
      return {
        missing: existing.rows.length === 0,
        alreadyDone: true,
        row: existing.rows[0] as { id: string; source_id: string; state: string } | undefined,
      };
    }
    const job = claimed.rows[0] as { id: string; source_id: string; state: string; cursor: string | null };
    const source = await client.query(
      `SELECT id, connector, path, metadata FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [job.source_id, params.orgId]
    );
    const sourceRow = source.rows[0] as
      | { id: string; connector: string; path: string; metadata: unknown }
      | undefined;
    return { missing: false, alreadyDone: false, job, sourceRow };
  });

  if (loaded.missing) {
    throw ApplicationFailure.nonRetryable(`ingestion job ${params.jobId} not found`, 'InvalidArgumentError');
  }
  if (loaded.alreadyDone) {
    return { status: 'skipped', skipReason: 'hash', processed: 0 };
  }
  if (!loaded.sourceRow || !loaded.job) {
    throw ApplicationFailure.nonRetryable(
      'knowledge_sources row missing for ingestion job',
      'InvalidArgumentError'
    );
  }

  const payload = readPendingPayload(loaded.sourceRow.metadata, {
    pendingText: '',
    source: resolveMemorySourceKind(loaded.sourceRow.connector),
    sourceRef: loaded.sourceRow.path,
  });

  try {
    return await processLoadedJob({
      orgId: params.orgId,
      jobId: params.jobId,
      sourceId: loaded.sourceRow.id,
      payload,
    });
  } catch (err: unknown) {
    const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
    /**
     * A VENDOR'S DAILY QUOTA MUST NOT PERMANENTLY DELETE A CUSTOMER'S DOCUMENT.
     *
     * Marking the job `failed` takes it out of the queued sweep for good, so a
     * file uploaded on the day the embedding quota ran out would never be
     * searchable - and nothing would say so. Requeued instead, which is what
     * `embedQueuedJobsActivity` exists to drain once the quota resets.
     */
    const requeue = isQuotaExhausted(message);
    await withOrgClient(params.orgId, (client) =>
      markJob(client, {
        orgId: params.orgId,
        jobId: params.jobId,
        sourceId: loaded.sourceRow!.id,
        state: requeue ? 'queued' : 'failed',
        error: message,
      })
    );
    throw err;
  }
}

export async function embedQueuedJobsActivity(params: {
  orgId: string;
  limit?: number;
}): Promise<EmbedJobResult> {
  if (!params.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  const limit = Math.min(Math.max(params.limit ?? EMBED_BATCH_SIZE, 1), 128);

  const jobs = await withOrgClient(params.orgId, async (client) => {
    const claimed = await client.query(
      `UPDATE ingestion_jobs
          SET state = 'running', started_at = COALESCE(started_at, NOW())
        WHERE id IN (
          SELECT id FROM ingestion_jobs
           WHERE org_id = $1 AND state = 'queued'
           ORDER BY created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, source_id`,
      [params.orgId, limit]
    );
    const rows = claimed.rows as Array<{ id: string; source_id: string }>;
    const loaded: Array<{ jobId: string; sourceId: string; payload: PendingEmbedPayload }> = [];
    for (const row of rows) {
      const source = await client.query(
        `SELECT id, connector, path, metadata FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [row.source_id, params.orgId]
      );
      const sourceRow = source.rows[0] as
        | { id: string; connector: string; path: string; metadata: unknown }
        | undefined;
      if (!sourceRow) continue;
      loaded.push({
        jobId: row.id,
        sourceId: sourceRow.id,
        payload: readPendingPayload(sourceRow.metadata, {
          pendingText: '',
          source: resolveMemorySourceKind(sourceRow.connector),
          sourceRef: sourceRow.path,
        }),
      });
    }
    return loaded;
  });

  let processed = 0;
  let last: EmbedJobResult = { status: 'skipped', skipReason: 'empty', processed: 0 };
  const toEmbed: typeof jobs = [];

  for (const job of jobs) {
    const redacted = redactForEmbed(job.payload.pendingText, {
      kind: job.payload.kind,
      dataClass: job.payload.dataClass,
    });
    if (redacted.skipped && redacted.reason) {
      await withOrgClient(params.orgId, (client) =>
        markJob(client, {
          orgId: params.orgId,
          jobId: job.jobId,
          sourceId: job.sourceId,
          state: 'succeeded',
          cursor: skipCursor(redacted.reason as EmbedSkipReason),
          error: null,
        })
      );
      processed += 1;
      last = { status: 'skipped', skipReason: redacted.reason, processed };
      continue;
    }
    toEmbed.push({
      ...job,
      payload: { ...job.payload, pendingText: redacted.text },
    });
  }

  const stillEmbed: typeof toEmbed = [];
  for (const job of toEmbed) {
    const contentHash = hashEmbedContent(job.payload.pendingText);
    const hit = await withOrgClient(params.orgId, async (client) => {
      const target = await resolveWriteTarget(
        client,
        params.orgId,
        job.payload.source,
        job.payload.sourceRef
      );
      const existingId = await findExistingMemoryId(client, {
        orgId: params.orgId,
        source: job.payload.source,
        sourceRef: job.payload.sourceRef,
        contentHash,
        target,
      });
      return { target, existingId, contentHash };
    });
    if (hit.existingId) {
      await withOrgClient(params.orgId, (client) =>
        markJob(client, {
          orgId: params.orgId,
          jobId: job.jobId,
          sourceId: job.sourceId,
          state: 'succeeded',
          cursor: skipCursor('hash'),
          error: null,
          contentHash: hit.contentHash,
        })
      );
      processed += 1;
      last = { status: 'skipped', skipReason: 'hash', memoryId: hit.existingId, processed };
      continue;
    }
    stillEmbed.push(job);
  }

  if (stillEmbed.length === 0) {
    return last;
  }

  const vectors = await createEmbeddingsOrDegrade(stillEmbed.map((job) => job.payload.pendingText));

  for (let i = 0; i < stillEmbed.length; i++) {
    const job = stillEmbed[i];
    const embedding = vectors[i];
    const contentHash = hashEmbedContent(job.payload.pendingText);
    try {
      const memoryId = await withOrgClient(params.orgId, async (client) => {
        const target = await resolveWriteTarget(
          client,
          params.orgId,
          job.payload.source,
          job.payload.sourceRef
        );
        const id = await insertMemoryRow(client, {
          orgId: params.orgId,
          source: job.payload.source,
          sourceRef: job.payload.sourceRef,
          body: job.payload.pendingText,
          contentHash,
          embedding,
          target,
          metadata: {
            ingestionJobId: job.jobId,
            knowledgeSourceId: job.sourceId,
            embeddingDim: SCHEMA_EMBEDDING_DIM,
          },
        });
        await markJob(client, {
          orgId: params.orgId,
          jobId: job.jobId,
          sourceId: job.sourceId,
          state: 'succeeded',
          cursor: contentHash,
          error: null,
          contentHash,
        });
        return id;
      });
      processed += 1;
      last = { status: 'embedded', memoryId, processed };
    } catch (err: unknown) {
      const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
      // Same reasoning as the single-job path: a spent quota requeues, it does
      // not discard the document.
      const requeue = isQuotaExhausted(message);
      await withOrgClient(params.orgId, (client) =>
        markJob(client, {
          orgId: params.orgId,
          jobId: job.jobId,
          sourceId: job.sourceId,
          state: requeue ? 'queued' : 'failed',
          error: message,
        })
      );
      throw err;
    }
  }

  return last;
}
