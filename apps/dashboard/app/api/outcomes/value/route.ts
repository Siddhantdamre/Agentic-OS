import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/outcomes/value — record a meeting, a payment or a closed deal.
 *
 * WHY THIS EXISTS
 * outcome_events has carried value_numeric and the kinds meeting_booked /
 * payment_received / deal_closed since migration 022, and nothing had ever
 * written one — so the money metrics could only ever report zero. No payment
 * provider is connected, and none is required: this is the door, and a
 * Razorpay or Stripe webhook is just another caller of it later.
 *
 * Body:
 *   kind         meeting_booked | payment_received | deal_closed
 *   amount       optional for a meeting, required for a payment
 *   currency     required whenever an amount is given
 *   sourceId     the id in YOUR system — invoice number, booking ref, deal id
 *   sourceTable  where that id lives, defaults to 'manual'
 *   conversationId  optional, and what makes the AI/human split possible
 *   occurredAt   optional ISO timestamp for backfilling
 *
 * Idempotent on (org, sourceTable, sourceId, kind): a retrying webhook or a
 * double-clicked button cannot double-count revenue. That matters more here
 * than anywhere else in the product — inflated revenue is the one error a
 * customer will find on their own, and it discredits every other number.
 */
const KINDS = new Set(['meeting_booked', 'payment_received', 'deal_closed']);

export async function POST(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
    const sourceTable = typeof body.sourceTable === 'string' && body.sourceTable.trim()
      ? body.sourceTable.trim()
      : 'manual';
    const currency = typeof body.currency === 'string' ? body.currency.trim() : '';
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
    const occurredAt = typeof body.occurredAt === 'string' ? body.occurredAt : null;

    // Numbers arrive from JSON, where a string "1000" and the number 1000 are
    // both plausible. Accept both, reject anything that is not finite — an
    // amount of NaN would sum into a total of NaN and take the whole page
    // down with it.
    let amount: number | null = null;
    if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
      const n = Number(body.amount);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ error: 'amount must be a number.' }, { status: 400 });
      }
      amount = n;
    }

    if (!KINDS.has(kind)) {
      return NextResponse.json(
        { error: 'kind must be meeting_booked, payment_received or deal_closed.' },
        { status: 400 },
      );
    }
    if (!sourceId) {
      return NextResponse.json(
        { error: 'sourceId is required — every value outcome must trace back to a record in your system.' },
        { status: 400 },
      );
    }

    // The conversation must belong to this org. RLS enforces it, but an
    // explicit check turns a silent NULL — which would quietly drop this
    // revenue out of the AI/human split — into a visible 404.
    if (conversationId) {
      const conv = await client.query(
        `SELECT id FROM conversations WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [conversationId, orgId],
      );
      if (!conv.rows.length) {
        return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
      }
    }

    const res = await client.query(
      `SELECT record_value_outcome($1::uuid, $2::uuid, $3::text, $4::numeric,
                                    $5::text, $6::text, $7::text, $8::timestamptz) AS id`,
      [orgId, conversationId, kind, amount, currency || null, sourceTable, sourceId, occurredAt],
    );

    const id = res.rows[0]?.id ?? null;
    return NextResponse.json({
      // null means it was already recorded. Reported plainly rather than as an
      // error: a webhook retrying is correct behaviour, not a failure.
      status: id ? 'recorded' : 'already recorded',
      outcomeId: id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // The database function raises readable messages for the cases a caller
    // can fix — an amount with no currency, a payment with no amount — so pass
    // those back rather than replacing them with a generic 500.
    if (/needs a currency|needs an amount|needs a source_id|not a value outcome/.test(message)) {
      return NextResponse.json({ error: message.replace(/^.*?:\s*/, '') }, { status: 400 });
    }
    console.error('[outcomes/value]', message);
    return NextResponse.json({ error: 'Could not record that outcome.' }, { status: 500 });
  } finally {
    client.release();
  }
}
