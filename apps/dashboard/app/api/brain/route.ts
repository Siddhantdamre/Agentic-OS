import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient } from '@/lib/db';
import { enqueueEmbedJob } from '@/lib/embed-enqueue';
import { lookupUserById } from '@/lib/auth-user';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_AFTER_DAYS = parseInt(process.env.MEMORY_STALE_AFTER_DAYS || '21', 10);
const SNIPPET_CHARS = 480;

type BrainTier = 'org' | 'employee' | 'entity' | 'conversation';
type SourceStatus = 'pending' | 'syncing' | 'ready' | 'stale' | 'error' | 'disabled' | 'conflict';

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

async function loadBrain(
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

  const snippets: BrainSnippet[] = snippetRes.rows
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

  const entities: BrainEntity[] = entityRes.rows.map((row) => ({
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    snippet: (row.snippet || '').replace(/\s+/g, ' ').trim(),
    stale: Boolean(row.stale),
    updatedAt: iso(row.updated_at),
  }));

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

  const sources: BrainSource[] = sourceRes.rows.map((row) => {
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

  return { snippets, entities, sources };
}

async function reindexSource(
  client: PoolClient,
  orgId: string,
  sourceId: string
): Promise<{ enqueued: boolean; skipped?: string }> {
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
  if (!row) return { enqueued: false, skipped: 'missing' };

  const pending =
    row.metadata && typeof row.metadata.pendingText === 'string' ? row.metadata.pendingText : '';
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
  if (!text) return { enqueued: false, skipped: 'empty' };

  const result = await enqueueEmbedJob({
    orgId,
    source: row.connector,
    sourceRef: row.path,
    text,
  });
  if (result.enqueued) return { enqueued: true };
  return { enqueued: false, skipped: result.skipReason };
}

export async function GET(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const query = searchParams.get('q') || '';
      const user = await lookupUserById(client, userId);
      const { snippets, entities, sources } = await loadBrain(client, orgId, query);
      const empty = snippets.length === 0 && entities.length === 0 && sources.length === 0;
      return NextResponse.json({
        empty,
        query,
        canMutate: canMutateBrain(user?.role || ''),
        snippets,
        entities,
        sources,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/brain Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const user = await lookupUserById(client, userId);
      if (!canMutateBrain(user?.role || '')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const action = typeof body?.action === 'string' ? body.action : '';
      switch (action) {
        // ── Type a fact ─────────────────────────────────────────────────────
        // Until now the ONLY way to teach the agent anything was to upload a
        // file. For an SMB owner that is the difference between a thirty-second
        // action and a task that never happens — and it showed: reply_edits and
        // typed knowledge were both at zero while the agent answered 719
        // conversations from pack defaults.
        //
        // Written at priority 100, the value migration 026 defines as "human
        // correction". A person stating a fact outranks a PDF that contradicts
        // it, which is the same rule an operator's reply edit already gets.
        case 'add-fact': {
          const title = String(body?.title || '').trim();
          const factBody = String(body?.body || '').trim();
          const kind = ['faq', 'policy', 'sop'].includes(String(body?.kind))
            ? String(body.kind) : 'faq';

          if (!factBody) {
            return NextResponse.json(
              { error: 'Write the fact you want the assistant to know.' }, { status: 400 });
          }
          if (factBody.length > 4000) {
            return NextResponse.json(
              { error: 'Keep it under 4000 characters. Upload a file for anything longer.' },
              { status: 400 });
          }

          // Same conflict target as every other writer: the unique index is
          // (org_id, source, source_ref, content_hash). Naming content_hash
          // alone does not match it, and the insert silently does nothing.
          const inserted = await client.query(
            `INSERT INTO org_memory
               (org_id, kind, title, body, source, source_ref, content_hash, priority, metadata)
             VALUES ($1, $2, $3, $4, 'operator', $5,
                     encode(digest($4, 'sha256'), 'hex'), 100,
                     jsonb_build_object('author_user_id', $6::text))
             ON CONFLICT (org_id, source, source_ref, content_hash) DO UPDATE
               SET title = EXCLUDED.title,
                   kind = EXCLUDED.kind,
                   updated_at = NOW()
             RETURNING id, (xmax = 0) AS created`,
            [orgId, kind, title || factBody.slice(0, 60), factBody, `fact:${userId}`, userId],
          );
          const row = inserted.rows[0];

          // Deliberately NOT enqueued for embedding. enqueueEmbedJob runs the
          // whole ingestion path — it writes its own knowledge_source and its
          // own org_memory rows — so calling it here would store the fact
          // twice. Retrieval is full-text today (0 of 1,127 rows carry an
          // embedding, and there is no GEMINI_API_KEY), so the fact is
          // searchable the moment this returns. When embeddings are switched
          // on, backfill from org_memory rather than double-writing here.

          return NextResponse.json({
            id: row.id,
            created: row.created,
            message: row.created
              ? 'Learned. Your assistant will use this from now on.'
              : 'You had already told it this — updated.',
          });
        }
        case 'reindex': {
          const rawId = typeof body?.sourceId === 'string' ? body.sourceId : '';
          const sourceId = rawId.startsWith('source:') ? rawId.slice(7) : rawId;
          if (!isUuid(sourceId)) {
            return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
          }
          const result = await reindexSource(client, orgId, sourceId);
          return NextResponse.json(result);
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
      }
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/brain Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
