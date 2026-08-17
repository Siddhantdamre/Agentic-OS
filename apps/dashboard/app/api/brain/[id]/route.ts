import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient } from '@/lib/db';
import { lookupUserById } from '@/lib/auth-user';
import { enqueueEmbedJob } from '@/lib/embed-enqueue';

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

    const { client, orgId, userId } = await getScopedClient();
    try {
      if (!(await requireMutator(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const action = typeof body?.action === 'string' ? body.action : 'correct';

      switch (action) {
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
          const sql =
            parsed.kind === 'conversation'
              ? `UPDATE conversation_memory
                    SET body = $3,
                        summary = $3,
                        title = COALESCE($4, title),
                        updated_at = NOW()
                  WHERE id = $1 AND org_id = $2
                  RETURNING id`
              : `UPDATE ${table}
                    SET body = $3,
                        title = COALESCE($4, title),
                        updated_at = NOW()
                  WHERE id = $1 AND org_id = $2
                  RETURNING id`;
          const res = await client.query(sql, [parsed.id, orgId, nextBody, nextTitle]);
          if (!res.rows[0]?.id) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
          }
          return NextResponse.json({ ok: true, id: `${parsed.kind}:${parsed.id}` });
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
        return NextResponse.json({ ok: true, deletedId: `source:${parsed.id}` });
      }

      const table = tableForTier(parsed.kind);
      const res = await client.query(
        `DELETE FROM ${table} WHERE id = $1 AND org_id = $2 RETURNING id`,
        [parsed.id, orgId]
      );
      if (!res.rows[0]?.id) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, deletedId: `${parsed.kind}:${parsed.id}` });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('DELETE /api/brain/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    const parsed = parseBrainId(decodeURIComponent(rawId));
    if (!parsed || parsed.kind !== 'source') {
      return NextResponse.json({ error: 'Reindex requires a source id' }, { status: 400 });
    }
    const { client, orgId, userId } = await getScopedClient();
    try {
      if (!(await requireMutator(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const src = await client.query<{
        connector: string;
        path: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT connector, path, metadata FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [parsed.id, orgId]
      );
      const row = src.rows[0];
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const pending =
        row.metadata && typeof row.metadata.pendingText === 'string' ? row.metadata.pendingText : '';
      let text = pending.trim();
      if (!text) {
        const bodies = await client.query<{ body: string }>(
          `SELECT body FROM org_memory WHERE org_id = $1 AND source = $2 AND source_ref = $3 LIMIT 8`,
          [orgId, row.connector, row.path]
        );
        text = bodies.rows.map((r) => r.body).join('\n\n').trim();
      }
      if (!text) {
        return NextResponse.json({ enqueued: false, skipped: 'empty' });
      }
      const result = await enqueueEmbedJob({
        orgId,
        source: row.connector,
        sourceRef: row.path,
        text,
      });
      return NextResponse.json(
        result.enqueued
          ? { enqueued: true }
          : { enqueued: false, skipped: result.skipReason }
      );
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/brain/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
