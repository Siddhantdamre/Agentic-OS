import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/knowledge-gaps/{id} — answer a question the agent could not.
 *
 * Body: { answer: string, title?: string }   teach it
 *       { dismiss: true }                    not something it should know
 *
 * The answer goes straight into org_memory as a `faq` row via
 * resolve_knowledge_gap (migration 025), stored alongside the customer's own
 * phrasing of the question — so the next person who asks it the same way
 * matches on the words they actually used, not on the words an operator would
 * have chosen.
 *
 * Dismissal is a first-class outcome, not a failure to answer. "What's the
 * weather" is not something a furniture business's agent should know, and a
 * list that cannot be cleared of those stops being read within a week.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const { id: gapId } = await context.params;
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const dismiss = body.dismiss === true;

    // RLS scopes this, but an explicit check turns a silent no-op into a 404.
    const found = await client.query(
      `SELECT id, status FROM knowledge_gaps WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [gapId, orgId],
    );
    if (!found.rows.length) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    if (found.rows[0].status !== 'open') {
      return NextResponse.json(
        { error: `This gap is already ${found.rows[0].status}.` },
        { status: 409 },
      );
    }

    if (dismiss) {
      await client.query(
        `UPDATE knowledge_gaps SET status = 'dismissed', resolved_at = NOW()
          WHERE id = $1 AND org_id = $2`,
        [gapId, orgId],
      );
      return NextResponse.json({ status: 'dismissed' });
    }

    // A one-word answer is not knowledge. Refusing it here keeps the memory
    // clean — the same reasoning that makes record_reply_edit skip a
    // sub-20-character edit.
    if (answer.length < 20) {
      return NextResponse.json(
        { error: 'Write a full answer — a few words will not help the agent reply well.' },
        { status: 400 },
      );
    }

    const res = await client.query(
      `SELECT resolve_knowledge_gap($1::uuid, $2::uuid, $3::text, $4::text) AS memory_id`,
      [orgId, gapId, title, answer],
    );

    return NextResponse.json({
      status: 'resolved',
      memoryId: res.rows[0]?.memory_id ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[knowledge-gaps/:id]', message);
    return NextResponse.json({ error: 'Could not save that answer.' }, { status: 500 });
  } finally {
    client.release();
  }
}
