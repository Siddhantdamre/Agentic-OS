import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { formatDeviation } from '@/lib/brief-format';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

function titleFromMetadata(metadata: unknown, fallback: string): string {
  if (!metadata || typeof metadata !== 'object') return fallback;
  const rec = metadata as Record<string, unknown>;
  const card = rec.card && typeof rec.card === 'object' ? (rec.card as Record<string, unknown>) : rec;
  if (typeof card.title === 'string' && card.title) return card.title;
  if (typeof card.companyName === 'string' && card.companyName) return card.companyName;
  if (typeof card.issue === 'string' && card.issue) return card.issue;
  if (typeof card.label === 'string' && card.label) return card.label;
  if (typeof card.summary === 'string' && card.summary) return card.summary;
  return fallback;
}

function detailFromMetadata(metadata: unknown, status: string): string {
  if (!metadata || typeof metadata !== 'object') return status;
  const rec = metadata as Record<string, unknown>;
  const card = rec.card && typeof rec.card === 'object' ? (rec.card as Record<string, unknown>) : rec;
  if (typeof card.situation === 'string' && card.situation) return card.situation;
  if (typeof card.whyNow === 'string' && card.whyNow) return card.whyNow;
  if (typeof card.summary === 'string' && card.summary) return card.summary;
  return status.replace(/_/g, ' ');
}

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams.get('limit'));
    const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0);
    // Optional IANA tz for overnight window; default UTC with honest label.
    const tzRaw = (searchParams.get('tz') || 'UTC').trim();
    const tz = /^[A-Za-z0-9_+\-/]+$/.test(tzRaw) ? tzRaw : 'UTC';

    const { client, orgId } = await getScopedClient();
    try {
      let exceptions: Array<{
        id: string;
        title: string;
        detail: string;
        status: string;
        deviation: string | null;
        dueAt: string | null;
      }> = [];
      let handledOvernight = 0;
      let totalOpen = 0;
      let truncated = false;
      let handledWindowHours = 16;
      let handledWindowLabel = 'last 16 hours (UTC)';

      try {
        const countRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM work_items
            WHERE org_id = $1
              AND status IN ('needs_attention', 'waiting_approval')`,
          [orgId]
        );
        totalOpen = parseInt(String(countRes.rows[0]?.count || '0'), 10) || 0;

        const open = await client.query(
          `SELECT id, type, status, due_at, metadata, updated_at
             FROM work_items
            WHERE org_id = $1
              AND status IN ('needs_attention', 'waiting_approval')
            ORDER BY
              CASE status WHEN 'needs_attention' THEN 0 ELSE 1 END,
              due_at ASC NULLS LAST,
              updated_at DESC
            LIMIT $2 OFFSET $3`,
          [orgId, limit, offset]
        );
        truncated = offset + open.rows.length < totalOpen;
        exceptions = open.rows.map((row: {
          id: string;
          type: string;
          status: string;
          due_at: string | null;
          metadata: unknown;
        }) => ({
          id: row.id,
          title: titleFromMetadata(row.metadata, row.type || 'Work item'),
          detail: detailFromMetadata(row.metadata, row.status),
          status: row.status,
          deviation: formatDeviation(row.due_at),
          dueAt: row.due_at,
        }));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'work_items')) throw err;
      }

      try {
        // Local overnight: from previous local 16:00 to now when tz is valid; else 16h UTC.
        const handled = await client.query(
          `SELECT COUNT(*)::text AS count
             FROM work_items
            WHERE org_id = $1
              AND status IN ('done', 'cancelled')
              AND updated_at >= (
                CASE
                  WHEN $2::text = 'UTC' THEN NOW() - INTERVAL '16 hours'
                  ELSE (
                    (date_trunc('day', NOW() AT TIME ZONE $2) - INTERVAL '1 day' + INTERVAL '16 hours')
                    AT TIME ZONE $2
                  )
                END
              )`,
          [orgId, tz]
        );
        handledOvernight = parseInt(String(handled.rows[0]?.count || '0'), 10);
        if (tz !== 'UTC') {
          handledWindowLabel = `since yesterday 16:00 (${tz})`;
          handledWindowHours = 0;
        }
      } catch (err: unknown) {
        if (!isMissingTable(err, 'work_items')) {
          // Invalid timezone → honest UTC fallback
          try {
            const handled = await client.query(
              `SELECT COUNT(*) FROM work_items
                WHERE org_id = $1
                  AND status IN ('done', 'cancelled')
                  AND updated_at >= NOW() - INTERVAL '16 hours'`,
              [orgId]
            );
            handledOvernight = parseInt(String(handled.rows[0]?.count || '0'), 10);
            handledWindowLabel = 'last 16 hours (UTC fallback)';
          } catch (inner: unknown) {
            if (!isMissingTable(inner, 'work_items')) throw inner;
          }
        }
      }

      return NextResponse.json({
        orgId,
        exceptions,
        handledOvernight,
        totalOpen,
        limit,
        offset,
        truncated,
        handledWindowHours,
        handledWindowLabel,
        timezone: tz,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (isMissingTable(error)) {
      return NextResponse.json({
        exceptions: [],
        handledOvernight: 0,
        totalOpen: 0,
        truncated: false,
      });
    }
    console.error('GET /api/brief Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
