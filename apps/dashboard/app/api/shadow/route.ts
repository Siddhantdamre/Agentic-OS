import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import {
  summariseAgreement,
  agreementSentence,
  type AgreementCase,
} from '@darex/workflows/dist/outcomes/agreement.js';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/shadow — would the agent have done what you did?
 * POST /api/shadow — turn shadow mode on or off.
 *
 * The evidence comes from two places that were already being written:
 *
 *   reply_edits         the draft, beside what the operator actually sent
 *   approval_requests   what the agent wanted to do, beside the human's answer
 *
 * Nobody else can show this number because nobody else stores the pairing.
 *
 * The arithmetic is a shared pure module with 14 unit tests, so the API shapes
 * the query and never re-implements the judgement — two copies of a trust
 * metric drift, and only one of them is tested.
 */
export async function GET(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(365, Math.max(1, Number(searchParams.get('days')) || 30));

    const mode = await client.query(
      `SELECT enabled, started_at FROM org_shadow_mode WHERE org_id = $1`, [orgId]);
    const enabled = Boolean(mode.rows[0]?.enabled);
    const startedAt: Date | null = mode.rows[0]?.started_at ?? null;

    // While shadow mode is ON, scope to the run. A rate that silently mixes
    // shadowed and unshadowed periods answers a question nobody asked.
    const sinceClause = enabled && startedAt ? '$2::timestamptz' : `NOW() - ($2 || ' days')::interval`;
    const sinceParam: string = enabled && startedAt ? startedAt.toISOString() : String(days);

    const edits = await client.query(
      `SELECT ai_draft, operator_final, created_at
         FROM reply_edits
        WHERE org_id = $1 AND created_at >= ${sinceClause}
          AND COALESCE(ai_draft, '') <> ''
        ORDER BY created_at`,
      [orgId, sinceParam],
    );

    const approvals = await client.query(
      `SELECT action_class, summary, draft, status, reason, decided_at
         FROM approval_requests
        WHERE org_id = $1 AND status IN ('approved', 'rejected')
          AND decided_at >= ${sinceClause}
        ORDER BY decided_at`,
      [orgId, sinceParam],
    );

    const cases: AgreementCase[] = [
      ...edits.rows.map((r) => ({
        source: 'reply' as const,
        proposed: r.ai_draft,
        humanOutcome: r.operator_final,
        at: r.created_at?.toISOString?.() ?? undefined,
      })),
      ...approvals.rows.map((r) => ({
        source: 'approval' as const,
        proposed: r.draft || r.summary || r.action_class,
        humanOutcome: r.status,
        reason: r.reason || undefined,
        at: r.decided_at?.toISOString?.() ?? undefined,
      })),
    ];

    const summary = summariseAgreement(cases);

    return NextResponse.json({
      shadowMode: { enabled, startedAt },
      periodDays: enabled && startedAt ? null : days,
      ...summary,
      // Only the ones worth reading, and capped so the payload stays a
      // dashboard rather than an export.
      disagreements: summary.disagreements.slice(0, 20),
      // The one sentence. Built by the shared module so the wording — "agreed
      // with you", never "was right" — cannot drift from what the tests pin.
      headline: agreementSentence(summary),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[shadow]', message);
    return NextResponse.json({ error: 'Could not load agreement.' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function POST(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId, userId } = scoped;

  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be true or false.' }, { status: 400 });
    }

    const res = await client.query(
      `SELECT set_shadow_mode($1::uuid, $2::boolean, $3::uuid) AS started_at`,
      [orgId, body.enabled, userId],
    );

    return NextResponse.json({
      enabled: body.enabled,
      startedAt: res.rows[0]?.started_at ?? null,
      message: body.enabled
        ? 'Shadow mode is on. The agent will draft every reply and send nothing until you do.'
        : 'Shadow mode is off. The agent will send replies again.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[shadow POST]', message);
    return NextResponse.json({ error: 'Could not change shadow mode.' }, { status: 500 });
  } finally {
    client.release();
  }
}
