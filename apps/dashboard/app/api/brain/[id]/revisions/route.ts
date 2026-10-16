import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { lookupUserById } from '@/lib/auth-user';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemoryTier = 'org' | 'employee' | 'entity' | 'conversation';

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

function parseBrainId(raw: string): { kind: MemoryTier; id: string } | null {
  const idx = raw.indexOf(':');
  if (idx <= 0) return UUID_RE.test(raw) ? { kind: 'org', id: raw } : null;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (!UUID_RE.test(id)) return null;
  switch (kind) {
    case 'org':
    case 'employee':
    case 'entity':
    case 'conversation':
      return { kind, id };
    default:
      return null;
  }
}

/** GET /api/brain/[id]/revisions — prior bodies for a memory row (session org). */
export async function GET(
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
      const user = await lookupUserById(client, userId);
      if (!canMutateBrain(user?.role || '')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const res = await client.query<{
        id: string;
        previous_title: string | null;
        previous_body: string;
        created_at: Date | string;
        changed_by_user_id: string | null;
      }>(
        `SELECT id, previous_title, previous_body, created_at, changed_by_user_id
           FROM memory_revisions
          WHERE org_id = $1 AND memory_id = $2 AND tier = $3
          ORDER BY created_at DESC
          LIMIT 50`,
        [orgId, parsed.id, parsed.kind]
      );
      return NextResponse.json({
        memoryId: `${parsed.kind}:${parsed.id}`,
        revisions: res.rows.map((row) => ({
          id: row.id,
          previousTitle: row.previous_title,
          previousBody: row.previous_body,
          changedByUserId: row.changed_by_user_id,
          createdAt:
            row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        })),
      });
    } catch (err: unknown) {
      const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
      if (code === '42P01') {
        return NextResponse.json({
          memoryId: `${parsed.kind}:${parsed.id}`,
          revisions: [],
          message: 'memory_revisions table not migrated yet',
        });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/brain/[id]/revisions Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
