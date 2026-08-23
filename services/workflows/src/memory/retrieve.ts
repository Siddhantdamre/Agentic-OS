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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_TOKEN_BUDGET = 3000;
const MIN_TOKEN_BUDGET = 256;
const MAX_TOKEN_BUDGET = 4000;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MEMORY_RETRIEVE_TIMEOUT_MS || '1200', 10);
const EMBED_TIMEOUT_MS = parseInt(process.env.MEMORY_EMBED_TIMEOUT_MS || '400', 10);
const STALE_AFTER_DAYS = parseInt(process.env.MEMORY_STALE_AFTER_DAYS || '21', 10);
const PER_TIER_LIMIT = 12;
const SNIPPET_CHARS = 480;
const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || '1536', 10);

const SOURCE_KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);

const CITATION_TIERS = ['org', 'employee', 'entity', 'conversation', 'working'] as const;
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
  /** 0 = ingested document, 100 = human correction. See migration 026. */
  priority: number;
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
 * Cited-facts block injected into the grounded **user** message (atomic-agent
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

async function embedQuery(query: string, timeoutMs: number): Promise<number[] | null> {
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

function vectorLiteral(vec: number[] | undefined): string | null {
  if (!vec || vec.length !== EMBEDDING_DIM) return null;
  return `[${vec.join(',')}]`;
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
    0 AS priority,
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
        AND ks.path = em.source_ref
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
  -- OR the query terms, do not AND them.
  --
  -- This was plainto_tsquery, which ANDs every term: "What time do you open on
  -- Saturday?" becomes 'time' & 'open' & 'saturday', and the opening-hours
  -- document does not contain the word "time", so it matched NOTHING. Measured,
  -- not theorised — every naturally phrased customer question missed the
  -- knowledge base entirely, while "opening hours saturday" matched fine.
  --
  -- The agent was not refusing to look. Retrieval returned zero rows, so it
  -- answered "I don't have your business hours stored" while the hours sat in
  -- org_memory. One stray word in a question emptied the whole knowledge base.
  --
  -- ORing recalls any document sharing a term; precision then comes from
  -- ts_rank_cd ordering and the existing top-K cut, which is where it belongs.
  -- Lexemes come from to_tsvector so stopwords are already dropped and each is
  -- quoted, keeping punctuation out of to_tsquery's parser.
  SELECT to_tsquery('english',
    COALESCE(
      NULLIF(
        array_to_string(
          ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS l),
          ' | '
        ),
        ''
      ),
      -- A query of pure stopwords yields no lexemes; an empty to_tsquery would
      -- error, so fall back to a token that matches nothing.
      'zzzznomatchzzz'
    )
  ) AS tsq
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
    om.priority,
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
        AND ks.path = om.source_ref
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
    0 AS priority,
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
        AND ks.path = en.source_ref
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
    0 AS priority,
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
    AND NOT EXISTS (
      SELECT 1 FROM knowledge_sources ks
      WHERE ks.org_id = cm.org_id
        AND ks.connector = cm.source
        AND ks.path = cm.source_ref
        AND ks.status = 'disabled'
    )
    AND (
      ($5::uuid IS NOT NULL AND cm.conversation_id = $5::uuid)
      OR cm.body_tsv @@ (SELECT tsq FROM q)
      OR ($3::vector IS NOT NULL AND cm.embedding IS NOT NULL AND (cm.embedding <=> $3::vector) < 0.45)
    )
) ranked
-- priority ahead of relevance, deliberately.
--
-- A priority-100 row is a human correction: an operator saw the agent answer
-- and rewrote it. When a correction and an ingested document both match the
-- same question, the human is right and the PDF is stale. Ranking by relevance
-- alone would let the document the operator was correcting outrank the
-- correction itself, which makes the whole learning loop pointless.
--
-- Everything ingested is priority 0, so this changes nothing until a human
-- actually corrects something.
ORDER BY entity_lock DESC, same_thread DESC, priority DESC, (0.4 * fts_rank + 0.6 * vec_sim) DESC, updated_at DESC
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
  ]);
  return res.rows;
}

async function retrieveOnce(params: RetrieveMemoryParams): Promise<RetrieveMemoryResult> {
  const orgId = params.orgId;
  if (!isUuid(orgId)) return emptyMemoryResult(orgId || '');

  const timeoutMs = Math.max(200, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const tokenBudget = clampTokenBudget(params.tokenBudget);
  let queryVec = vectorLiteral(params.queryEmbedding);
  if (!queryVec) {
    const embedBudget = Math.min(EMBED_TIMEOUT_MS, Math.max(100, timeoutMs - 200));
    const embedded = await embedQuery(params.query, embedBudget);
    queryVec = vectorLiteral(embedded || undefined);
  }

  return withOrgScopedClient(orgId, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(timeoutMs)]);
      const rows = await queryMemory(client, params, queryVec);
      await client.query('COMMIT');
      const citations = toCitations(rows, tokenBudget);
      return { orgId, citations, emptyIndex: citations.length === 0 };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — caller still releases
      }
      throw err;
    }
  });
}

function isUndefinedTable(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
  return code === '42P01';
}

/**
 * ACL/RLS retrieve. `orgId` must come from session/workflow — never a request body.
 * On timeout, missing tables, or any error: empty citations (honest miss, not invention).
 */
export async function retrieveMemory(params: RetrieveMemoryParams): Promise<RetrieveMemoryResult> {
  const orgId = params.orgId;
  const fallback = emptyMemoryResult(orgId || '');
  if (!isUuid(orgId)) return fallback;
  if (!params.query || !String(params.query).trim()) return fallback;

  const timeoutMs = Math.max(200, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const result = await Promise.race([
      retrieveOnce(params),
      new Promise<RetrieveMemoryResult>((resolve) => {
        setTimeout(() => resolve(fallback), timeoutMs + 50);
      }),
    ]);
    return result;
  } catch (err) {
    if (isUndefinedTable(err)) return fallback;
    console.warn('[retrieveMemory] failed closed-empty:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

export type { MemoryCitation, RetrieveMemoryRequest, RetrieveMemoryResult, MemoryTier };
