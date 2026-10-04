/**
 * Shared org-scoped memory retrieve (M3). Every agent path prefixes the user
 * message with cited facts from this function. Empty index → "no stored memory";
 * never invent contacts, listings, or prior conversations.
 *
 * Embeddings may be NULL (M2 not filled yet). Hybrid: tsvector first, cosine
 * when a query vector is available. Timeout so Ask AI simple stays in-class.
 */

import type {
  MemoryCitation,
  MemorySourceKind,
  MemoryTier,
  RetrieveMemoryRequest,
  RetrieveMemoryResult,
} from '@darex/shared-types';
import { MEMORY_SOURCE_KINDS } from '@darex/shared-types';
import type { PoolClient } from 'pg';
import { withOrgScopedClient } from '../tools/shared.js';
import { normalizeEmployeePersona, type EmployeePersona } from '../tools/role-capability.js';
import { searchCognee } from './cognee-client.js';
import { searchHindsight } from './hindsight-client.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PERSONA_TOKEN_BUDGET: Record<EmployeePersona, number> = {
  customer: 1800,
  operations: 1200,
  growth: 1600,
  sales: 1600,
  marketing: 1600,
  finance: 1400,
};

const DEFAULT_TOKEN_BUDGET = 3000;
const MIN_TOKEN_BUDGET = 256;
const MAX_TOKEN_BUDGET = 4000;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MEMORY_RETRIEVE_TIMEOUT_MS || '3500', 10);
const EMBED_TIMEOUT_MS = parseInt(process.env.MEMORY_EMBED_TIMEOUT_MS || '400', 10);
const STALE_AFTER_DAYS = parseInt(process.env.MEMORY_STALE_AFTER_DAYS || '21', 10);
const PER_TIER_LIMIT = 12;
const SNIPPET_CHARS = 480;
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1536', 10);

const SOURCE_KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);

const CITATION_TIERS = ['org', 'employee', 'entity', 'conversation', 'working', 'graph'] as const;
type CitationTier = (typeof CITATION_TIERS)[number];

export const EMPTY_MEMORY_BLOCK =
  'Retrieved facts (cite ids, do not invent):\nno stored memory\nIf a fact is missing, say it is missing. Tools still run.';

export interface RetrieveMemoryParams extends RetrieveMemoryRequest {
  /** Test/hook: skip LiteLLM and search with this vector. Dim must match EMBEDDING_DIM. */
  queryEmbedding?: number[];
  timeoutMs?: number;
}

interface CandidateRow {
  id: string;
  tier: string;
  snippet: string;
  source: string;
  source_ref: string | null;
  updated_at: Date | string;
  stale: boolean;
  fts_rank: number;
  vec_sim: number;
  entity_lock: number;
  same_thread: number;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function clampTokenBudget(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Number(raw) : DEFAULT_TOKEN_BUDGET;
  return Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, n));
}

function asSource(raw: string | null | undefined): MemorySourceKind {
  const value = (raw || '').trim();
  if (SOURCE_KIND_SET.has(value)) return value as MemorySourceKind;
  return 'human';
}

function asTier(raw: string): CitationTier {
  for (const tier of CITATION_TIERS) {
    if (tier === raw) return tier;
  }
  return 'org';
}

function isoDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function dayStamp(value: Date | string): string {
  const iso = isoDate(value);
  return iso ? iso.slice(0, 10) : '';
}

export function emptyMemoryResult(orgId: string): RetrieveMemoryResult {
  return { orgId, citations: [], emptyIndex: true };
}

/** Top-citation presence used by the customer confidence gate. Empty index is 0. */
export function ragTopSimilarity(memory: RetrieveMemoryResult): number {
  const scored = memory as RetrieveMemoryResult & { topSimilarity?: number };
  if (typeof scored.topSimilarity === 'number' && Number.isFinite(scored.topSimilarity)) {
    return scored.topSimilarity;
  }
  const n = Array.isArray(memory.citations) ? memory.citations.length : 0;
  if (n === 0 || memory.emptyIndex) return 0;
  return Math.min(1, 0.45 + n * 0.08);
}

/** Parent WorkItem activity shape. Facts are citation snippets only — never invented. */
export type RetrieveMemoryActivityResult = {
  facts: string[];
  citations: string[];
  noOp: boolean;
  emptyIndex: boolean;
};

export function toRetrieveActivityResult(memory: RetrieveMemoryResult): RetrieveMemoryActivityResult {
  const citations = Array.isArray(memory.citations) ? memory.citations : [];
  return {
    facts: citations.map((c) => String(c.snippet || '').trim()).filter((s) => s.length > 0),
    citations: citations.map((c) => String(c.id || '')).filter((id) => id.length > 0),
    noOp: false,
    emptyIndex: memory.emptyIndex === true || citations.length === 0,
  };
}

/**
 * Cited-facts block injected into the grounded **user** message (TrueForge
 * drops `system`). Empty citations always emit "no stored memory" — never
 * Kapoor/listing filler.
 */
export function formatRetrievedFactsBlock(memory: RetrieveMemoryResult): string {
  if (!memory.citations.length) return EMPTY_MEMORY_BLOCK;
  const lines = memory.citations.map((c) => {
    const updated = dayStamp(c.updatedAt);
    const bits = [
      `[${c.id}] ${c.snippet}`,
      `source=${c.source}`,
      `stale=${c.stale}`,
    ];
    if (updated) bits.push(`updated ${updated}`);
    return bits.join(', ');
  });
  return [
    'Retrieved facts (cite ids, do not invent):',
    ...lines,
    'If a fact is missing, say it is missing. Tools still run.',
  ].join('\n');
}

function embeddingsUrl(): string {
  const base = (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  if (base.endsWith('/v1')) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

/** LiteLLM query embed for hybrid search. Returns null when model/key/timeout missing — callers must fall back to keyword honestly. */
export async function embedQueryText(
  query: string,
  timeoutMs: number = EMBED_TIMEOUT_MS
): Promise<number[] | null> {
  const model = process.env.EMBEDDING_MODEL;
  if (!model || !query.trim()) return null;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(embeddingsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: query.slice(0, 8000) }),
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

/** @deprecated use embedQueryText — kept as internal alias for retrieveOnce */
async function embedQuery(query: string, timeoutMs: number): Promise<number[] | null> {
  return embedQueryText(query, timeoutMs);
}

export function embeddingVectorLiteral(vec: number[] | undefined): string | null {
  if (!vec || vec.length !== EMBEDDING_DIM) return null;
  return `[${vec.join(',')}]`;
}

function vectorLiteral(vec: number[] | undefined): string | null {
  return embeddingVectorLiteral(vec);
}

export type MemoryHybridHit = {
  id: string;
  tier: string;
  snippet: string;
  source: string;
  source_ref: string | null;
  updated_at: Date | string;
  stale: boolean;
  fts_rank: number;
  vec_sim: number;
};

/**
 * Same hybrid FTS + cosine path as agent retrieveMemory (no employee/entity lock).
 * Pass queryEmbedding from embedQueryText after releasing any DB client.
 * When queryEmbedding is null, cosine terms are zero and FTS still matches.
 */
export async function searchMemoryHybrid(
  client: PoolClient,
  params: {
    orgId: string;
    query: string;
    queryEmbedding?: number[] | null;
    limit?: number;
    staleAfterDays?: number;
  }
): Promise<MemoryHybridHit[]> {
  const q = params.query.trim().slice(0, 2000);
  if (!q || !isUuid(params.orgId)) return [];
  const queryVec = vectorLiteral(params.queryEmbedding || undefined);
  const staleDays =
    Number.isFinite(params.staleAfterDays) && (params.staleAfterDays as number) > 0
      ? (params.staleAfterDays as number)
      : Number.isFinite(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0
        ? STALE_AFTER_DAYS
        : 21;
  const limit = Math.min(100, Math.max(1, params.limit ?? PER_TIER_LIMIT * 4));
  const sql = hybridSql(false);
  const res = await client.query<MemoryHybridHit>(sql, [
    params.orgId,
    q,
    queryVec,
    null,
    null,
    null,
    null,
    staleDays,
    limit,
    false,
  ]);
  return res.rows;
}

function hybridSql(hasEmployee: boolean): string {
  const employeeBranch = hasEmployee
    ? `
  UNION ALL
  SELECT
    em.id::text AS id,
    'employee'::text AS tier,
    left(trim(both FROM concat_ws(' — ', NULLIF(em.title, ''), em.body)), ${SNIPPET_CHARS}) AS snippet,
    em.source,
    em.source_ref,
    em.updated_at,
    (em.updated_at < NOW() - ($8::int * INTERVAL '1 day')) AS stale,
    ts_rank_cd(em.body_tsv, (SELECT tsq FROM q))::float8 AS fts_rank,
    CASE
      WHEN $3::vector IS NULL OR em.embedding IS NULL THEN 0::float8
      ELSE (1 - (em.embedding <=> $3::vector))::float8
    END AS vec_sim,
    0 AS entity_lock,
    0 AS same_thread
  FROM employee_memory em
  WHERE em.org_id = $1::uuid
    AND em.employee_id = $4::uuid
    AND (em.expires_at IS NULL OR em.expires_at > NOW())
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_sources ks
      WHERE ks.org_id = em.org_id
        AND ks.connector = em.source
        AND ks.path IN (em.source_ref, regexp_replace(em.source_ref, '#(c|chunk-)[0-9]+$', ''))
        AND ks.status = 'disabled'
    )
    AND (
      em.body_tsv @@ (SELECT tsq FROM q)
      OR ($3::vector IS NOT NULL AND em.embedding IS NOT NULL AND (em.embedding <=> $3::vector) < 0.45)
    )
  `
    : '';

  return `
WITH q AS (
  SELECT COALESCE(NULLIF(websearch_to_tsquery('english', $2), ''::tsquery), plainto_tsquery('english', $2)) AS tsq, $4::uuid AS _emp
)
SELECT * FROM (
  SELECT
    om.id::text AS id,
    'org'::text AS tier,
    left(trim(both FROM concat_ws(' — ', NULLIF(om.title, ''), om.body)), ${SNIPPET_CHARS}) AS snippet,
    om.source,
    om.source_ref,
    om.updated_at,
    (om.updated_at < NOW() - ($8::int * INTERVAL '1 day')) AS stale,
    ts_rank_cd(om.body_tsv, (SELECT tsq FROM q))::float8 AS fts_rank,
    CASE
      WHEN $3::vector IS NULL OR om.embedding IS NULL THEN 0::float8
      ELSE (1 - (om.embedding <=> $3::vector))::float8
    END AS vec_sim,
    0 AS entity_lock,
    0 AS same_thread
  FROM org_memory om
  WHERE om.org_id = $1::uuid
    AND (om.expires_at IS NULL OR om.expires_at > NOW())
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_sources ks
      WHERE ks.org_id = om.org_id
        AND ks.connector = om.source
        AND ks.path IN (om.source_ref, regexp_replace(om.source_ref, '#(c|chunk-)[0-9]+$', ''))
        AND ks.status = 'disabled'
    )
    AND (
      om.body_tsv @@ (SELECT tsq FROM q)
      OR ($3::vector IS NOT NULL AND om.embedding IS NOT NULL AND (om.embedding <=> $3::vector) < 0.45)
    )
  ${employeeBranch}
  UNION ALL
  SELECT
    en.id::text AS id,
    'entity'::text AS tier,
    left(trim(both FROM concat_ws(' — ', NULLIF(en.title, ''), en.body)), ${SNIPPET_CHARS}) AS snippet,
    en.source,
    en.source_ref,
    en.updated_at,
    (en.updated_at < NOW() - ($8::int * INTERVAL '1 day')) AS stale,
    ts_rank_cd(en.body_tsv, (SELECT tsq FROM q))::float8 AS fts_rank,
    CASE
      WHEN $3::vector IS NULL OR en.embedding IS NULL THEN 0::float8
      ELSE (1 - (en.embedding <=> $3::vector))::float8
    END AS vec_sim,
    CASE
      WHEN $6::text IS NOT NULL AND $7::text IS NOT NULL
           AND en.entity_type = $6 AND en.entity_id = $7 THEN 1
      ELSE 0
    END AS entity_lock,
    0 AS same_thread
  FROM entity_memory en
  WHERE en.org_id = $1::uuid
    AND (en.expires_at IS NULL OR en.expires_at > NOW())
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_sources ks
      WHERE ks.org_id = en.org_id
        AND ks.connector = en.source
        AND ks.path IN (en.source_ref, regexp_replace(en.source_ref, '#(c|chunk-)[0-9]+$', ''))
        AND ks.status = 'disabled'
    )
    AND (
      ($6::text IS NOT NULL AND $7::text IS NOT NULL AND en.entity_type = $6 AND en.entity_id = $7)
      OR en.body_tsv @@ (SELECT tsq FROM q)
      OR ($3::vector IS NOT NULL AND en.embedding IS NOT NULL AND (en.embedding <=> $3::vector) < 0.45)
    )
  UNION ALL
  SELECT
    cm.id::text AS id,
    'conversation'::text AS tier,
    left(trim(both FROM concat_ws(' — ', NULLIF(cm.title, ''), NULLIF(cm.summary, ''), cm.body)), ${SNIPPET_CHARS}) AS snippet,
    cm.source,
    cm.source_ref,
    cm.updated_at,
    (cm.updated_at < NOW() - ($8::int * INTERVAL '1 day')) AS stale,
    ts_rank_cd(cm.body_tsv, (SELECT tsq FROM q))::float8 AS fts_rank,
    CASE
      WHEN $3::vector IS NULL OR cm.embedding IS NULL THEN 0::float8
      ELSE (1 - (cm.embedding <=> $3::vector))::float8
    END AS vec_sim,
    0 AS entity_lock,
    CASE WHEN $5::uuid IS NOT NULL AND cm.conversation_id = $5::uuid THEN 1 ELSE 0 END AS same_thread
  FROM conversation_memory cm
  WHERE cm.org_id = $1::uuid
    AND (cm.expires_at IS NULL OR cm.expires_at > NOW())
    -- $10 thread_only: Customer persona may only cite this conversation's
    -- memory, never another customer's thread (MEM-S02).
    AND (NOT $10::boolean OR ($5::uuid IS NOT NULL AND cm.conversation_id = $5::uuid))
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_sources ks
      WHERE ks.org_id = cm.org_id
        AND ks.connector = cm.source
        AND ks.path IN (cm.source_ref, regexp_replace(cm.source_ref, '#(c|chunk-)[0-9]+$', ''))
        AND ks.status = 'disabled'
    )
    AND (
      ($5::uuid IS NOT NULL AND cm.conversation_id = $5::uuid)
      OR cm.body_tsv @@ (SELECT tsq FROM q)
      OR ($3::vector IS NOT NULL AND cm.embedding IS NOT NULL AND (cm.embedding <=> $3::vector) < 0.45)
    )
) ranked
ORDER BY entity_lock DESC, same_thread DESC,
  ((0.4 * fts_rank + 0.6 * vec_sim) - CASE WHEN stale THEN 0.15 ELSE 0 END) DESC,
  CASE WHEN stale THEN 1 ELSE 0 END,
  updated_at DESC
LIMIT $9
`;
}

function toCitations(rows: CandidateRow[], tokenBudget: number): MemoryCitation[] {
  const seen = new Set<string>();
  const citations: MemoryCitation[] = [];
  let used = estimateTokens(EMPTY_MEMORY_BLOCK);
  let n = 0;
  for (const row of rows) {
    if (!row.snippet || !row.snippet.trim()) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    n += 1;
    const citation: MemoryCitation = {
      id: `M-${n}`,
      tier: asTier(row.tier),
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
      source: asSource(row.source),
      sourceRef: row.source_ref,
      stale: Boolean(row.stale),
      updatedAt: isoDate(row.updated_at),
    };
    const lineTokens = estimateTokens(
      `[${citation.id}] ${citation.snippet} source=${citation.source} stale=${citation.stale} updated ${dayStamp(citation.updatedAt)}`,
    );
    if (citations.length > 0 && used + lineTokens > tokenBudget) break;
    citations.push(citation);
    used += lineTokens;
  }
  return citations;
}

/** Customer persona: conversation tier limited to the current thread. */
export function conversationThreadOnly(employeeRole: string | undefined | null): boolean {
  return normalizeEmployeePersona(employeeRole) === 'customer';
}

async function queryMemory(
  client: PoolClient,
  params: RetrieveMemoryParams,
  queryVec: string | null,
): Promise<CandidateRow[]> {
  const hasEmployee = isUuid(params.employeeId);
  const sql = hybridSql(hasEmployee);
  const res = await client.query<CandidateRow>(sql, [
    params.orgId,
    params.query.slice(0, 2000),
    queryVec,
    hasEmployee ? params.employeeId : null,
    isUuid(params.conversationId) ? params.conversationId : null,
    params.entityType || null,
    params.entityId || null,
    Number.isFinite(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0 ? STALE_AFTER_DAYS : 21,
    PER_TIER_LIMIT * 4,
    conversationThreadOnly(params.employeeRole),
  ]);
  return res.rows;
}

function trimToTokenBudget(citations: MemoryCitation[], tokenBudget: number): MemoryCitation[] {
  let used = estimateTokens(EMPTY_MEMORY_BLOCK);
  const out: MemoryCitation[] = [];
  for (const citation of citations) {
    const lineTokens = estimateTokens(`[${citation.id}] ${citation.snippet}`);
    if (out.length > 0 && used + lineTokens > tokenBudget) break;
    out.push(citation);
    used += lineTokens;
  }
  return out;
}

function snippetKey(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * SQL row citations first, then Cognee graph snippets that are not the same text.
 * Graph ids stay in the G- namespace so a model can tell them from M- rows.
 */
export function mergeMemoryCitations(
  sqlCitations: MemoryCitation[],
  graphCitations: MemoryCitation[],
): MemoryCitation[] {
  const seen = new Set<string>();
  const out: MemoryCitation[] = [];
  for (const citation of sqlCitations) {
    const key = snippetKey(citation.snippet || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  let graphN = 1;
  for (const citation of graphCitations) {
    const key = snippetKey(citation.snippet || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const id = citation.id && citation.id.startsWith('G-') ? citation.id : `G-${graphN}`;
    graphN += 1;
    out.push({ ...citation, id });
  }
  return out;
}

async function retrieveOnce(params: RetrieveMemoryParams): Promise<RetrieveMemoryResult> {
  const orgId = params.orgId;
  if (!isUuid(orgId)) return emptyMemoryResult(orgId || '');

  const timeoutMs = Math.max(200, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const tokenBudget = clampTokenBudget(params.tokenBudget);

  const useCognee = process.env.USE_COGNEE !== 'false';
  const cogneePromise = (async (): Promise<MemoryCitation[]> => {
    if (!useCognee) return [];
    try {
      const cogneeTimeout = Math.min(timeoutMs, Number(process.env.COGNEE_SEARCH_TIMEOUT_MS || 6000));
      return await searchCognee({
        orgId,
        query: params.query,
        searchType: 'GRAPH_COMPLETION',
        topK: 10,
        timeoutMs: cogneeTimeout,
      });
    } catch (cogneeErr: unknown) {
      const message = cogneeErr instanceof Error ? cogneeErr.message : String(cogneeErr);
      console.warn('[cognee] Search error, keeping SQL memory:', message);
      return [];
    }
  })();

  // Hindsight recall runs in parallel too; same failure policy (keep SQL memory).
  const hindsightPromise = (async (): Promise<MemoryCitation[]> => {
    if (process.env.USE_HINDSIGHT === 'false') return [];
    try {
      return await searchHindsight({
        orgId,
        query: params.query,
        topK: 8,
        timeoutMs: Math.min(timeoutMs, Number(process.env.HINDSIGHT_SEARCH_TIMEOUT_MS || 6000)),
      });
    } catch (err: unknown) {
      console.warn('[hindsight] Search error, keeping SQL memory:', err instanceof Error ? err.message : err);
      return [];
    }
  })();

  // Embed before checkout so the pool is not held during the model call.
  let queryVec = vectorLiteral(params.queryEmbedding);
  if (!queryVec) {
    const embedBudget = Math.min(EMBED_TIMEOUT_MS, Math.max(100, timeoutMs - 200));
    const embedded = await embedQuery(params.query, embedBudget);
    queryVec = vectorLiteral(embedded || undefined);
  }

  let sqlCitations: MemoryCitation[] = [];
  try {
    sqlCitations = await withOrgScopedClient(orgId, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(timeoutMs)]);
        await client.query('SAVEPOINT hnsw_iterative_scan');
        try {
          await client.query(`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
          await client.query('RELEASE SAVEPOINT hnsw_iterative_scan');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT hnsw_iterative_scan');
        }
        const rows = await queryMemory(client, params, queryVec);
        await client.query('COMMIT');
        return toCitations(rows, tokenBudget);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure — caller still releases
        }
        throw err;
      }
    });
  } catch (err) {
    if (!isUndefinedTable(err)) {
      console.warn(
        '[retrieveMemory] sql search failed:',
        err instanceof Error ? err.message : err,
      );
    }
    sqlCitations = [];
  }

  const graphCitations = [...(await cogneePromise), ...(await hindsightPromise)];
  const combined = trimToTokenBudget(
    mergeMemoryCitations(sqlCitations, graphCitations),
    tokenBudget,
  );
  return { orgId, citations: combined, emptyIndex: combined.length === 0 };
}

function isUndefinedTable(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  return code === '42P01';
}

function formatFact(row: {
  predicate: string;
  object_type: string;
  object_text: string | null;
  object_number: string | number | null;
  object_money_minor: string | number | null;
  object_currency: string | null;
  object_date: Date | string | null;
  object_bool: boolean | null;
}): string {
  switch (row.object_type) {
    case 'text':
      return `${row.predicate}: ${row.object_text || ''}`.trim();
    case 'number':
      return `${row.predicate}: ${row.object_number ?? ''}`.trim();
    case 'money':
      return `${row.predicate}: ${row.object_money_minor ?? ''} ${row.object_currency || ''}`.trim();
    case 'date':
      return `${row.predicate}: ${row.object_date ?? ''}`.trim();
    case 'bool':
      return `${row.predicate}: ${row.object_bool ?? ''}`.trim();
    case 'ref':
      return `${row.predicate}: ref`.trim();
    default:
      return row.predicate;
  }
}

async function retrieveFactsFirst(params: RetrieveMemoryParams): Promise<MemoryCitation[]> {
  if (!isUuid(params.orgId) || !isUuid(params.entityId)) return [];
  try {
    return await withOrgScopedClient(params.orgId, async (client) => {
      const res = await client.query(
        `SELECT id, predicate, object_type, object_text, object_number,
                object_money_minor, object_currency, object_date, object_bool, updated_at
           FROM facts
          WHERE org_id = $1
            AND subject_id = $2
            AND status = 'current'
            AND (valid_to IS NULL OR valid_to > NOW())
          ORDER BY updated_at DESC
          LIMIT 8`,
        [params.orgId, params.entityId]
      );
      return res.rows.map((row) => ({
        id: `fact:${row.id}`,
        tier: 'org' as const,
        snippet: formatFact(row),
        source: 'human' as const,
        sourceRef: row.predicate,
        stale: false,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      }));
    });
  } catch {
    return [];
  }
}

export function filterCitationsForPersona(
  persona: EmployeePersona | null | undefined,
  citations: MemoryCitation[],
  params?: { entityId?: string }
): MemoryCitation[] {
  if (!persona) return citations;
  switch (persona) {
    case 'customer':
      // Never: other customers' entity memory. If entityId is specified, match it.
      // Never: graph snippets — cognified transcripts from other customers.
      return citations.filter((c) => {
        if (c.tier === 'graph') return false;
        if (c.tier === 'entity' && params?.entityId && c.sourceRef && c.sourceRef !== params.entityId) {
          return false;
        }
        return true;
      });
    case 'operations':
      // Never: conversation prose — needs state, not narrative.
      return citations.filter((c) => c.tier !== 'conversation' && c.tier !== 'graph');
    case 'growth':
      // Never: individual conversation transcripts.
      return citations.filter((c) => c.tier !== 'conversation' && c.tier !== 'graph');
    case 'sales':
      // Sales keeps conversation + CRM context; exclude unrelated entity noise only when scoped.
      return citations.filter((c) => {
        if (c.tier === 'entity' && params?.entityId && c.sourceRef && c.sourceRef !== params.entityId) {
          return false;
        }
        return true;
      });
    case 'marketing':
      return citations.filter((c) => c.tier !== 'conversation' && c.tier !== 'graph');
    case 'finance':
      return citations;
    default: {
      const _exhaustive: never = persona;
      return _exhaustive;
    }
  }
}

/**
 * ACL/RLS retrieve. `orgId` must come from session/workflow — never a request body.
 * On timeout, missing tables, or any error: empty citations (honest miss, not invention).
 * When `employeeRole` is provided, applies 20 §2 role scoping (persona token budget,
 * facts-first for ops/growth, and citation tier exclusion).
 */
export async function retrieveMemory(params: RetrieveMemoryParams): Promise<RetrieveMemoryResult> {
  const orgId = params.orgId;
  const fallback = emptyMemoryResult(orgId || '');
  if (!isUuid(orgId)) return fallback;
  if (!params.query || !String(params.query).trim()) return fallback;

  const persona = normalizeEmployeePersona(params.employeeRole);
  const tokenBudget = params.tokenBudget ?? (persona ? PERSONA_TOKEN_BUDGET[persona] : undefined);
  const timeoutMs = Math.max(200, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const factsPromise = (persona === 'operations' || persona === 'growth')
    ? retrieveFactsFirst(params)
    : Promise.resolve<MemoryCitation[]>([]);

  try {
    const [result, facts] = await Promise.all([
      Promise.race([
        retrieveOnce({ ...params, tokenBudget }),
        new Promise<RetrieveMemoryResult>((resolve) => {
          setTimeout(() => resolve(fallback), timeoutMs + 50);
        }),
      ]),
      factsPromise,
    ]);

    if (!persona) {
      if (facts.length === 0) return result;
      const combined = [...facts, ...result.citations];
      return {
        orgId,
        citations: combined,
        emptyIndex: combined.length === 0,
      };
    }

    const filtered = filterCitationsForPersona(persona, result.citations, { entityId: params.entityId });
    const combined = [...facts, ...filtered];
    return {
      orgId,
      citations: combined,
      emptyIndex: combined.length === 0,
    };
  } catch (err) {
    if (isUndefinedTable(err)) return fallback;
    console.warn('[retrieveMemory] failed closed-empty:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

export type { MemoryCitation, RetrieveMemoryRequest, RetrieveMemoryResult, MemoryTier };
export { searchHindsight, retainHindsight, isHindsightHealthy } from './hindsight-client.js';
export { searchCognee, rememberCognee, isCogneeHealthy, isCogneeCircuitOpen, tripCogneeCircuit, closeCogneeCircuit } from './cognee-client.js';
