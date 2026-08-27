import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';

export const dynamic = 'force-dynamic';

/**
 * POST /api/conversations/{id}/reply — an operator sends a reply, possibly
 * after editing what the AI proposed.
 *
 * This is the learning loop the product was missing. Migration 025 captures
 * questions the agent could not answer; that covers knowing nothing. It does
 * not cover the more common and more damaging case: the agent answers, the
 * answer is subtly wrong, a human rewrites it before sending, and that
 * rewrite — the highest-quality training signal the system will ever see — is
 * thrown away.
 *
 * An operator editing a reply is a domain expert saying "not that, THIS", about
 * a real customer, in their own words. Every edit should make the same mistake
 * impossible tomorrow.
 *
 * Body: { text: string, aiDraft?: string }
 *   text     what the operator actually sends
 *   aiDraft  what the AI had proposed. Omit when writing from scratch.
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
  const { client, orgId, userId } = scoped;

  try {
    const { id: conversationId } = await context.params;
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const aiDraft = typeof body.aiDraft === 'string' ? body.aiDraft.trim() : '';

    if (!text) {
      return NextResponse.json({ error: 'A reply cannot be empty.' }, { status: 400 });
    }

    // The conversation must belong to this org. RLS enforces it too, but an
    // explicit check returns 404 instead of a confusing empty result.
    //
    // The channel join is not incidental: this reply has to REACH the
    // customer. An earlier version of this route only inserted a row, which
    // would have recorded the operator's correction perfectly and left the
    // customer waiting on a message that was never sent.
    const conv = await client.query(
      `SELECT c.id, c.contact_id, c.chatwoot_conv_id,
              ch.channel_type, ch.meta AS channel_meta
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
        WHERE c.id = $1 AND c.org_id = $2
        LIMIT 1`,
      [conversationId, orgId],
    );
    if (!conv.rows.length) {
      return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    }
    const row = conv.rows[0];

    // The question this reply answers: the most recent customer message.
    // Without it a correction is an orphan — a right answer to an unknown
    // question teaches nothing.
    const q = await client.query(
      `SELECT content FROM messages
       WHERE org_id = $1 AND conversation_id = $2 AND role = 'user'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, conversationId],
    );
    const question = q.rows[0]?.content || '';

    // Send first, learn second. The customer's reply must never be delayed or
    // lost because the learning step had a problem.
    //
    // Recorded as 'human_agent', not 'assistant'. A corrected reply was
    // written by a person, and labelling it as the agent's own output would
    // poison every later measurement — quality scoring, outcome attribution
    // and the transcript an operator reads to decide whether the agent is
    // improving would all count human work as machine work.
    const saved = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content)
       VALUES ($1, $2, 'human_agent', $3) RETURNING id`,
      [orgId, conversationId, text],
    );

    await client.query(
      `UPDATE conversations SET updated_at = NOW(), summary = $1
        WHERE id = $2 AND org_id = $3`,
      [text.slice(0, 100), conversationId, orgId],
    );

    // Deliver to the channel the customer is actually on. Fire-and-forget for
    // the same reason the insert comes first: a courier problem must not lose
    // the operator's work or block the response they are waiting on.
    const replyTarget = replyTargetFromChannelMeta(
      row.channel_type ?? 'dashboard',
      row.contact_id ?? 'unknown',
      (row.channel_meta || {}) as Record<string, unknown>,
      { chatwootConvId: row.chatwoot_conv_id },
    );
    void sendChannelReply(orgId, replyTarget, text);

    realtimeHub.publish(orgId, {
      type: 'conversation_updated',
      conversationId,
      message: text.slice(0, 200),
      contactId: row.contact_id ?? 'unknown',
      channelType: row.channel_type ?? 'dashboard',
    });

    let learning: {
      captured: boolean;
      learned: boolean;
      skipReason: string | null;
      memoryId: string | null;
    } = { captured: false, learned: false, skipReason: null, memoryId: null };

    if (aiDraft) {
      try {
        const res = await client.query(
          `SELECT * FROM record_reply_edit($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::uuid)`,
          [orgId, conversationId, question, aiDraft, text, userId],
        );
        const row = res.rows[0] || {};
        learning = {
          captured: true,
          learned: Boolean(row.learned),
          skipReason: row.skip_reason || null,
          memoryId: row.memory_id || null,
        };
      } catch (err: unknown) {
        // Never fail a sent reply because learning failed — the customer has
        // their answer either way, and losing one training signal is not worth
        // an error the operator has to think about.
        const message = err instanceof Error ? err.message : String(err);
        console.error('[conversations/reply] learning step failed:', message);
      }
    }

    return NextResponse.json({
      status: 'sent',
      messageId: saved.rows[0].id,
      learning,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[conversations/reply]', message);
    return NextResponse.json({ error: 'Could not send the reply.' }, { status: 500 });
  } finally {
    client.release();
  }
}
