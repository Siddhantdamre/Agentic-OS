import { createHash, randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { enqueueEmbedJob } from '@/lib/embed-enqueue';
import { enqueueReindexEmbed, loadKnowledgeSourceForReindex } from '@/lib/brain-reindex';
import { lookupUserById } from '@/lib/auth-user';
import {
  embedQueryText,
  searchMemoryHybrid,
} from '@darex/workflows/dist/memory/retrieve';
import { hindsightEnabled, listHindsight, searchHindsight } from '@darex/workflows/dist/memory/hindsight-client';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_AFTER_DAYS = parseInt(process.env.MEMORY_STALE_AFTER_DAYS || '21', 10);
const SNIPPET_CHARS = 480;

type BrainTier = 'org' | 'employee' | 'entity' | 'conversation';
type SourceStatus = 'pending' | 'syncing' | 'ready' | 'stale' | 'error' | 'disabled' | 'conflict';
type SearchMode = 'list' | 'hybrid' | 'keyword';

export type BrainSnippet = {
  id: string;
  tier: BrainTier;
  title: string | null;
  snippet: string;
  source: string;
  sourceRef: string | null;
  stale: boolean;
  updatedAt: string;
  entityType?: string | null;
  entityId?: string | null;
  conversationId?: string | null;
};

export type BrainEntity = {
  entityType: string;
  entityId: string;
  title: string | null;
  snippet: string;
  stale: boolean;
  updatedAt: string;
};

export type BrainSource = {
  id: string;
  connector: string;
  path: string;
  status: SourceStatus;
  lastSynced: string | null;
  disabled: boolean;
};

type SnippetRow = {
  id: string;
  tier: string;
  title: string | null;
  snippet: string;
  source: string;
  source_ref: string | null;
  updated_at: Date | string;
  stale: boolean;
  entity_type: string | null;
  entity_id: string | null;
  conversation_id: string | null;
};

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function asTier(raw: string): BrainTier {
  switch (raw) {
    case 'org':
    case 'employee':
    case 'entity':
    case 'conversation':
      return raw;
    default:
      return 'org';
  }
}

function asSourceStatus(raw: string): SourceStatus {
  switch (raw) {
    case 'pending':
    case 'syncing':
    case 'ready':
    case 'stale':
    case 'error':
    case 'disabled':
    case 'conflict':
      return raw;
    default:
      return 'pending';
  }
}

function canMutateBrain(role: string): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'agent':
      return false;
    default:
      return false;
  }
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const DISABLED_SOURCE_SQL = `
  NOT EXISTS (
    SELECT 1 FROM knowledge_sources ks
    WHERE ks.org_id = t.org_id
      AND ks.connector = t.source
      AND ks.path = t.source_ref
      AND ks.status = 'disabled'
  )
`;

function searchSql(hasQuery: boolean): string {
  // $2 is always bound (loadBrain passes ' ' when there's no query text), so
  // it must appear in the SQL text unconditionally — otherwise Postgres
  // can't infer its type ("could not determine data type of parameter $2").
  const match = hasQuery
    ? `AND t.body_tsv @@ plainto_tsquery('english', $2)`
    : `AND $2::text IS NOT NULL`;
  return `
SELECT * FROM (
  SELECT
    om.id::text AS id,
    'org'::text AS tier,
    om.title,
    left(trim(both FROM concat_ws(' — ', NULLIF(om.title, ''), om.body)), ${SNIPPET_CHARS}) AS snippet,
    om.source,
    om.source_ref,
    om.updated_at,
    (om.updated_at < NOW() - ($3::int * INTERVAL '1 day')) AS stale,
    NULL::text AS entity_type,
    NULL::text AS entity_id,
    NULL::uuid AS conversation_id,
    om.org_id,
    om.body_tsv
  FROM org_memory om
  WHERE om.org_id = $1::uuid
  UNION ALL
  SELECT
    em.id::text, 'employee'::text, em.title,
    left(trim(both FROM concat_ws(' — ', NULLIF(em.title, ''), em.body)), ${SNIPPET_CHARS}),
    em.source, em.source_ref, em.updated_at,
    (em.updated_at < NOW() - ($3::int * INTERVAL '1 day')),
    NULL, NULL, NULL, em.org_id,
    em.body_tsv
  FROM employee_memory em
  WHERE em.org_id = $1::uuid
  UNION ALL
  SELECT
    en.id::text, 'entity'::text, en.title,
    left(trim(both FROM concat_ws(' — ', NULLIF(en.title, ''), en.body)), ${SNIPPET_CHARS}),
    en.source, en.source_ref, en.updated_at,
    (en.updated_at < NOW() - ($3::int * INTERVAL '1 day')),
    en.entity_type, en.entity_id, NULL, en.org_id,
    en.body_tsv
  FROM entity_memory en
  WHERE en.org_id = $1::uuid
  UNION ALL
  SELECT
    cm.id::text, 'conversation'::text, cm.title,
    left(trim(both FROM concat_ws(' — ', NULLIF(cm.title, ''), NULLIF(cm.summary, ''), cm.body)), ${SNIPPET_CHARS}),
    cm.source, cm.source_ref, cm.updated_at,
    (cm.updated_at < NOW() - ($3::int * INTERVAL '1 day')),
    NULL, NULL, cm.conversation_id, cm.org_id,
    cm.body_tsv
  FROM conversation_memory cm
  WHERE cm.org_id = $1::uuid
) t
WHERE ${DISABLED_SOURCE_SQL}
  ${match}
ORDER BY t.updated_at DESC
LIMIT 50
`;
}

function mapSnippetRows(rows: SnippetRow[]): BrainSnippet[] {
  return rows
    .filter((row) => (row.snippet || '').trim())
    .map((row) => ({
      id: `${asTier(row.tier)}:${row.id}`,
      tier: asTier(row.tier),
      title: row.title,
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
      source: row.source || '',
      sourceRef: row.source_ref,
      stale: Boolean(row.stale),
      updatedAt: iso(row.updated_at),
      entityType: row.entity_type,
      entityId: row.entity_id,
      conversationId: row.conversation_id,
    }));
}

async function loadSources(
  client: PoolClient,
  orgId: string,
  query: string
): Promise<BrainSource[]> {
  const q = query.trim();
  const sourceRes = await client.query<{
    id: string;
    connector: string;
    path: string;
    status: string;
    last_synced: Date | string | null;
  }>(
    `SELECT id, connector, path, status, last_synced
       FROM knowledge_sources
      WHERE org_id = $1::uuid
        ${q ? `AND (connector ILIKE $2 OR path ILIKE $2)` : ''}
      ORDER BY updated_at DESC
      LIMIT 50`,
    q ? [orgId, `%${q.slice(0, 200)}%`] : [orgId]
  );

  return sourceRes.rows.map((row) => {
    const status = asSourceStatus(row.status);
    return {
      id: `source:${row.id}`,
      connector: row.connector,
      path: row.path,
      status,
      lastSynced: iso(row.last_synced) || null,
      disabled: status === 'disabled',
    };
  });
}

async function loadEntities(
  client: PoolClient,
  orgId: string,
  query: string,
  staleDays: number
): Promise<BrainEntity[]> {
  const q = query.trim();
  const entityRes = await client.query<{
    entity_type: string;
    entity_id: string;
    title: string | null;
    snippet: string;
    updated_at: Date | string;
    stale: boolean;
  }>(
    `SELECT entity_type, entity_id, title,
            left(trim(both FROM concat_ws(' — ', NULLIF(title, ''), body)), ${SNIPPET_CHARS}) AS snippet,
            updated_at,
            (updated_at < NOW() - ($2::int * INTERVAL '1 day')) AS stale
       FROM entity_memory
      WHERE org_id = $1::uuid
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_sources ks
           WHERE ks.org_id = entity_memory.org_id
             AND ks.connector = entity_memory.source
             AND ks.path = entity_memory.source_ref
             AND ks.status = 'disabled'
        )
        ${q ? `AND body_tsv @@ plainto_tsquery('english', $3)` : ''}
      ORDER BY updated_at DESC
      LIMIT 40`,
    q ? [orgId, staleDays, q.slice(0, 2000)] : [orgId, staleDays]
  );

  return entityRes.rows.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    snippet: (row.snippet || '').replace(/\s+/g, ' ').trim(),
    stale: Boolean(row.stale),
    updatedAt: iso(row.updated_at),
  }));
}

async function loadBrainKeyword(
  client: PoolClient,
  orgId: string,
  query: string
): Promise<{ snippets: BrainSnippet[]; entities: BrainEntity[]; sources: BrainSource[] }> {
  const q = query.trim();
  const staleDays = Number.isFinite(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0 ? STALE_AFTER_DAYS : 21;
  const snippetRes = await client.query<SnippetRow>(searchSql(Boolean(q)), [
    orgId,
    q.slice(0, 2000) || ' ',
    staleDays,
  ]);
  const snippets = mapSnippetRows(snippetRes.rows);
  const entities = await loadEntities(client, orgId, q, staleDays);
  const sources = await loadSources(client, orgId, q);
  return { snippets, entities, sources };
}

async function loadBrainHybrid(
  client: PoolClient,
  orgId: string,
  query: string,
  queryEmbedding: number[] | null
): Promise<{ snippets: BrainSnippet[]; entities: BrainEntity[]; sources: BrainSource[]; searchMode: SearchMode }> {
  const q = query.trim();
  const staleDays = Number.isFinite(STALE_AFTER_DAYS) && STALE_AFTER_DAYS > 0 ? STALE_AFTER_DAYS : 21;

  try {
    const hits = await searchMemoryHybrid(client, {
      orgId,
      query: q,
      queryEmbedding,
      limit: 50,
      staleAfterDays: staleDays,
    });
    const snippets: BrainSnippet[] = hits
      .filter((row) => (row.snippet || '').trim())
      .map((row) => ({
        id: `${asTier(row.tier)}:${row.id}`,
        tier: asTier(row.tier),
        title: null,
        snippet: row.snippet.replace(/\s+/g, ' ').trim(),
        source: row.source || '',
        sourceRef: row.source_ref,
        stale: Boolean(row.stale),
        updatedAt: iso(row.updated_at),
      }));
    const entities = await loadEntities(client, orgId, q, staleDays);
    const sources = await loadSources(client, orgId, q);
    return {
      snippets,
      entities,
      sources,
      searchMode: queryEmbedding ? 'hybrid' : 'keyword',
    };
  } catch (err: unknown) {
    // Honest fallback when pgvector / extension / operator is unavailable.
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === '42704' ||
      code === '42883' ||
      code === '42P01' ||
      /vector|pgvector|operator does not exist/i.test(message)
    ) {
      console.warn(`[brain] hybrid search unavailable (${code || message}); falling back to keyword`);
      const kw = await loadBrainKeyword(client, orgId, q);
      return { ...kw, searchMode: 'keyword' };
    }
    throw err;
  }
}

export type BrainGraphFact = { id: string; text: string; type: string; updatedAt: string };

/**
 * Facts the AI extracted from conversations (Hindsight), for this org only:
 * `orgId` always comes from the session. A failure is reported as
 * `graphUnavailable` so an outage never looks like "nothing learned".
 */
async function loadGraph(
  orgId: string,
  query: string
): Promise<{ graph: BrainGraphFact[]; graphUnavailable: boolean }> {
  if (!hindsightEnabled()) return { graph: [], graphUnavailable: false };
  try {
    if (query) {
      const hits = await searchHindsight({ orgId, query, topK: 25, timeoutMs: 4000 });
      return {
        graph: hits.map((h) => ({ id: h.id, text: h.snippet, type: 'fact', updatedAt: h.updatedAt })),
        graphUnavailable: false,
      };
    }
    return { graph: await listHindsight(orgId, 25), graphUnavailable: false };
  } catch (err) {
    console.warn('[brain] hindsight unavailable:', err instanceof Error ? err.message : err);
    return { graph: [], graphUnavailable: true };
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get('q') || '').trim();

    // Resolve session + role, then release before any LiteLLM embed call.
    const first = await getScopedClient();
    let canMutate = false;
    let orgId = first.orgId;
    try {
      const user = await lookupUserById(first.client, first.userId);
      canMutate = canMutateBrain(user?.role || '');
      orgId = first.orgId;
    } finally {
      first.client.release();
    }

    let queryEmbedding: number[] | null = null;
    if (query) {
      queryEmbedding = await embedQueryText(query, 800);
    }

    const { client } = await getScopedClient();
    try {
      if (!query) {
        const { snippets, entities, sources } = await loadBrainKeyword(client, orgId, '');
        const { graph, graphUnavailable } = await loadGraph(orgId, '');
        const empty =
          snippets.length === 0 && entities.length === 0 && sources.length === 0 && graph.length === 0;
        return NextResponse.json({
          graph,
          graphUnavailable,
          empty,
          query,
          canMutate,
          searchMode: 'list' as SearchMode,
          snippets,
          entities,
          sources,
        });
      }

      const { snippets, entities, sources, searchMode } = await loadBrainHybrid(
        client,
        orgId,
        query,
        queryEmbedding
      );
      const { graph, graphUnavailable } = await loadGraph(orgId, query);
      const empty =
        snippets.length === 0 && entities.length === 0 && sources.length === 0 && graph.length === 0;
      return NextResponse.json({
        graph,
        graphUnavailable,
        empty,
        query,
        canMutate,
        searchMode,
        snippets,
        entities,
        sources,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/brain Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : '';

    const { client, orgId, userId } = await getScopedClient();
    let createPayload: {
      id: string;
      source: string;
      sourceRef: string;
      text: string;
    } | null = null;
    let reindexLookup: Awaited<ReturnType<typeof loadKnowledgeSourceForReindex>> | null = null;

    try {
      const user = await lookupUserById(client, userId);
      if (!canMutateBrain(user?.role || '')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      switch (action) {
        case 'reindex': {
          const rawId = typeof body?.sourceId === 'string' ? body.sourceId : '';
          const sourceId = rawId.startsWith('source:') ? rawId.slice(7) : rawId;
          if (!isUuid(sourceId)) {
            return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
          }
          reindexLookup = await loadKnowledgeSourceForReindex(client, orgId, sourceId);
          break;
        }
        case 'create':
        case 'upload': {
          const nextBody = typeof body?.body === 'string' ? body.body.trim() : '';
          const nextTitle = typeof body?.title === 'string' ? body.title.trim() : '';
          const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
          if (action === 'upload' && filename) {
            const lower = filename.toLowerCase();
            if (lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.xlsx')) {
              return NextResponse.json(
                {
                  error:
                    'Binary PDF/DOCX/XLSX upload is not supported on this endpoint — paste text or use /api/brain/reindex with a connected Drive source.',
                },
                { status: 400 }
              );
            }
            if (!lower.endsWith('.txt') && !lower.endsWith('.md') && !lower.endsWith('.markdown')) {
              return NextResponse.json(
                { error: 'Only .txt / .md text uploads are accepted here' },
                { status: 400 }
              );
            }
          }
          if (!nextBody) {
            return NextResponse.json({ error: 'body is required' }, { status: 400 });
          }
          const sourceRef = filename ? `upload:${filename}` : `manual:${randomUUID()}`;
          const hash = contentHash(nextBody);
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
             VALUES ($1, 'sop', $2, $3, $4, $5, $6)
             RETURNING id`,
            [orgId, nextTitle || filename || null, nextBody, filename ? 'upload' : 'human', sourceRef, hash]
          );
          const id = inserted.rows[0]?.id;
          if (!id) {
            return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
          }
          createPayload = {
            id,
            source: filename ? 'upload' : 'human',
            sourceRef,
            text: nextBody,
          };
          break;
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
      }
    } finally {
      client.release();
    }

    if (reindexLookup) {
      if (!reindexLookup.ok) {
        return NextResponse.json({ enqueued: false, skipped: reindexLookup.skipped });
      }
      const result = await enqueueReindexEmbed(orgId, reindexLookup);
      return NextResponse.json(result);
    }

    if (createPayload) {
      // DB client already released before embed.
      const embed = await enqueueEmbedJob({
        orgId,
        source: createPayload.source,
        sourceRef: createPayload.sourceRef,
        text: createPayload.text,
        replaceMemory: { tier: 'org', id: createPayload.id },
      });
      return NextResponse.json({
        ok: true,
        id: `org:${createPayload.id}`,
        enqueued: embed.enqueued,
        skipped: embed.enqueued ? undefined : embed.skipReason,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth2 = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth2) return __scopedAuth2;
    console.error('POST /api/brain Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
