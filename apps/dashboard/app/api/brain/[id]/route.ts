import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { lookupUserById } from '@/lib/auth-user';
import { enqueueEmbedJob } from '@/lib/embed-enqueue';
import { realtimeHub } from '@/lib/realtime-hub';
import { enqueueReindexEmbed, loadKnowledgeSourceForReindex } from '@/lib/brain-reindex';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemoryTier = 'org' | 'employee' | 'entity' | 'conversation';

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
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

function parseBrainId(raw: string): { kind: MemoryTier | 'source'; id: string } | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return isUuid(raw) ? { kind: 'org', id: raw } : null;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!isUuid(id)) return null;
  switch (kind) {
    case 'org':
    case 'employee':
    case 'entity':
    case 'conversation':
    case 'source':
      return { kind, id };
    default:
      return null;
  }
}

function tableForTier(tier: MemoryTier): string {
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

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function requireMutator(client: PoolClient, userId: string): Promise<boolean> {
  const user = await lookupUserById(client, userId);
  return canMutateBrain(user?.role || '');
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const parsed = parseBrainId(decodeURIComponent(rawId));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'correct';

    let embedInput: {
      orgId: string;
      source: string;
      sourceRef: string;
      text: string;
      tier: MemoryTier;
      memoryId: string;
    } | null = null;

    const { client, orgId, userId } = await getScopedClient();
    try {
      if (!(await requireMutator(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      switch (action) {
        case 'disable':
        case 'enable': {
          // Disabling hides the file and all its chunks from retrieval and the
          // Brain list; syncs keep it disabled until it is enabled again.
          if (parsed.kind !== 'source') {
            return NextResponse.json({ error: 'Only a source can be disabled or enabled' }, { status: 400 });
          }
          const res = await client.query<{ id: string; status: string }>(
            `UPDATE knowledge_sources
                SET status = CASE WHEN $3 THEN 'disabled'
                                  WHEN status = 'disabled' THEN 'ready'
                                  ELSE status END,
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2
              RETURNING id, status`,
            [parsed.id, orgId, action === 'disable']
          );
          if (!res.rows[0]?.id) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
          }
          realtimeHub.publish(orgId, { type: 'memory.updated', message: `source:${parsed.id}` });
          return NextResponse.json({ ok: true, id: `source:${parsed.id}`, status: res.rows[0].status });
        }
        case 'correct': {
          if (parsed.kind === 'source') {
            return NextResponse.json({ error: 'Cannot correct a source; reindex instead' }, { status: 400 });
          }
          const nextBody = typeof body?.body === 'string' ? body.body.trim() : '';
          const nextTitle = typeof body?.title === 'string' ? body.title.trim() : null;
          if (!nextBody) {
            return NextResponse.json({ error: 'body is required' }, { status: 400 });
          }
          const table = tableForTier(parsed.kind);
          const hash = contentHash(nextBody);
          const prior = await client.query<{
            id: string;
            title: string | null;
            body: string;
            source: string;
            source_ref: string;
          }>(
            parsed.kind === 'conversation'
              ? `SELECT id, title, COALESCE(NULLIF(body, ''), summary) AS body, source, source_ref
                   FROM conversation_memory WHERE id = $1 AND org_id = $2 LIMIT 1`
              : `SELECT id, title, body, source, source_ref FROM ${table} WHERE id = $1 AND org_id = $2 LIMIT 1`,
            [parsed.id, orgId]
          );
          if (!prior.rows[0]?.id) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
          }
          try {
            await client.query(
              `INSERT INTO memory_revisions (org_id, memory_id, tier, previous_title, previous_body, changed_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [orgId, parsed.id, parsed.kind, prior.rows[0].title, prior.rows[0].body, userId]
            );
          } catch (err: unknown) {
            const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
            if (code !== '42P01') throw err;
          }
          // embedding cleared by 092 trigger (and explicitly here for pre-migration DBs).
          const sql =
            parsed.kind === 'conversation'
              ? `UPDATE conversation_memory
                    SET body = $3,
                        summary = $3,
                        title = COALESCE($4, title),
                        content_hash = $5,
                        embedding = NULL,
                        updated_at = NOW()
                  WHERE id = $1 AND org_id = $2
                  RETURNING id, source, source_ref`
              : `UPDATE ${table}
                    SET body = $3,
                        title = COALESCE($4, title),
                        content_hash = $5,
                        embedding = NULL,
                        updated_at = NOW()
                  WHERE id = $1 AND org_id = $2
                  RETURNING id, source, source_ref`;
          const res = await client.query<{
            id: string;
            source: string;
            source_ref: string;
          }>(sql, [parsed.id, orgId, nextBody, nextTitle, hash]);
          if (!res.rows[0]?.id) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
          }
          const row = res.rows[0];
          embedInput = {
            orgId,
            source: row.source || 'human',
            sourceRef: row.source_ref || `edit:${parsed.id}`,
            text: nextBody,
            tier: parsed.kind,
            memoryId: parsed.id,
          };
          break;
        }
        default:
          return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
      }
    } finally {
      client.release();
    }

    if (embedInput) {
      realtimeHub.publish(orgId, { type: 'memory.updated', message: `${embedInput.tier}:${embedInput.memoryId}` });
      // Client released before LiteLLM / Temporal work.
      const embed = await enqueueEmbedJob({
        orgId: embedInput.orgId,
        source: embedInput.source,
        sourceRef: embedInput.sourceRef,
        text: embedInput.text,
        replaceMemory: { tier: embedInput.tier, id: embedInput.memoryId },
      });
      return NextResponse.json({
        ok: true,
        id: `${embedInput.tier}:${embedInput.memoryId}`,
        enqueued: embed.enqueued,
        skipped: embed.enqueued ? undefined : embed.skipReason,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('PATCH /api/brain/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const parsed = parseBrainId(decodeURIComponent(rawId));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      if (!(await requireMutator(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      if (parsed.kind === 'source') {
        const res = await client.query(
          `DELETE FROM knowledge_sources WHERE id = $1 AND org_id = $2 RETURNING id`,
          [parsed.id, orgId]
        );
        if (!res.rows[0]?.id) {
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        realtimeHub.publish(orgId, { type: 'memory.updated', message: `source:${parsed.id}` });
        return NextResponse.json({ ok: true, deletedId: `source:${parsed.id}` });
      }

      const table = tableForTier(parsed.kind);
      // Embedding is a column on the memory row — DELETE removes the vector (no separate memory_embeddings table).
      const res = await client.query(
        `DELETE FROM ${table} WHERE id = $1 AND org_id = $2 RETURNING id`,
        [parsed.id, orgId]
      );
      if (!res.rows[0]?.id) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      realtimeHub.publish(orgId, { type: 'memory.updated', message: `${parsed.kind}:${parsed.id}` });
      return NextResponse.json({ ok: true, deletedId: `${parsed.kind}:${parsed.id}` });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth2 = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth2) return __scopedAuth2;
    console.error('DELETE /api/brain/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const parsed = parseBrainId(decodeURIComponent(rawId));
    if (!parsed || parsed.kind !== 'source') {
      return NextResponse.json({ error: 'Reindex requires a source id' }, { status: 400 });
    }
    const { client, orgId, userId } = await getScopedClient();
    let lookup: Awaited<ReturnType<typeof loadKnowledgeSourceForReindex>>;
    try {
      if (!(await requireMutator(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      lookup = await loadKnowledgeSourceForReindex(client, orgId, parsed.id);
    } finally {
      client.release();
    }
    if (!lookup.ok) {
      return NextResponse.json({ enqueued: false, skipped: lookup.skipped });
    }
    const result = await enqueueReindexEmbed(orgId, lookup);
    return NextResponse.json(
      result.enqueued
        ? { enqueued: true }
        : { enqueued: false, skipped: result.skipped }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth3 = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth3) return __scopedAuth3;
    console.error('POST /api/brain/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
