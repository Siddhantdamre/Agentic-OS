import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIONS = ['approve', 'snooze', 'dismiss'] as const;
type TriageAction = (typeof ACTIONS)[number];

function isAction(value: unknown): value is TriageAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

/**
 * POST /api/brief/[id]/triage — approve / snooze / dismiss a work item.
 * Session org only. Does not execute tools (no tool-executor) — status + audit only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: rawId } = await params;
    if (!UUID_RE.test(rawId)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }
    if (!isAction(body.action)) {
      return NextResponse.json({ error: 'action must be approve, snooze, or dismiss' }, { status: 400 });
    }
    const action = body.action;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
    const snoozeHours =
      body.snoozeDuration === 'tomorrow' ? 24 : body.snoozeDuration === 'afternoon' ? 4 : 2;

    const { client, orgId, userId } = await getScopedClient();
    try {
      const locked = await client.query(
        `SELECT id, status, metadata FROM work_items
          WHERE id = $1 AND org_id = $2
            AND status IN ('needs_attention', 'waiting_approval')
          FOR UPDATE`,
        [rawId, orgId]
      );
      if (!locked.rows[0]) {
        return NextResponse.json({ error: 'Work item not found or not actionable' }, { status: 404 });
      }

      switch (action) {
        case 'approve':
          await client.query(
            `UPDATE work_items
                SET status = 'done',
                    metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2`,
            [
              rawId,
              orgId,
              JSON.stringify({
                brief_triage: { action: 'approve', userId, note, at: new Date().toISOString() },
              }),
            ]
          );
          break;
        case 'snooze':
          await client.query(
            `UPDATE work_items
                SET due_at = NOW() + ($3::text || ' hours')::interval,
                    status = 'waiting_approval',
                    metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2`,
            [
              rawId,
              orgId,
              String(snoozeHours),
              JSON.stringify({
                brief_triage: { action: 'snooze', hours: snoozeHours, userId, at: new Date().toISOString() },
              }),
            ]
          );
          break;
        case 'dismiss':
          await client.query(
            `UPDATE work_items
                SET status = 'cancelled',
                    metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2`,
            [
              rawId,
              orgId,
              JSON.stringify({
                brief_triage: {
                  action: 'dismiss',
                  userId,
                  note: note || 'dismissed_via_brief',
                  at: new Date().toISOString(),
                },
              }),
            ]
          );
          break;
        default: {
          const _exhaustive: never = action;
          return NextResponse.json({ error: `Unhandled action ${_exhaustive}` }, { status: 400 });
        }
      }

      try {
        const kind = action === 'dismiss' ? 'plan.reject' : action === 'approve' ? 'plan.approve' : 'confirm.override';
        await client.query(
          `INSERT INTO audit_events (org_id, actor_type, actor_user_id, kind, result_status, work_item_id, payload)
           VALUES ($1, 'user', $2, $3, 'ok', $4, $5::jsonb)`,
          [orgId, userId, kind, rawId, JSON.stringify({ source: 'brief_triage', action, note })]
        );
      } catch (err: unknown) {
        if (!isMissingTable(err, 'audit_events')) {
          console.warn('[brief/triage] audit insert skipped:', err instanceof Error ? err.message : err);
        }
      }

      return NextResponse.json({ ok: true, itemId: rawId, action });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/brief/[id]/triage Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
