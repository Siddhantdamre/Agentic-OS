import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { canActOnConversations, loadHumanRole } from '@/lib/rbac';
import { draftReminder, formatRupees } from '@/lib/dues-text';
import { describeDue, readDuesSettings, type DueRow } from '@/lib/dues-view';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A reminder for one due. { preview: true } returns the draft only. Otherwise the draft (or the owner's edited
 * { message }) goes through the same gate as every message to a customer, so it waits in Approvals and nothing
 * reaches the buyer until a person approves it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'That item could not be found.' }, { status: 404 });
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });
      const role = await loadHumanRole(client, userId);
      if (!canActOnConversations(role)) {
        return NextResponse.json({ error: 'You do not have permission to send reminders.' }, { status: 403 });
      }
      const org = await client.query(`SELECT name, meta FROM orgs WHERE id = $1`, [orgId]);
      const settings = readDuesSettings(org.rows[0]?.meta);
      const res = await client.query(
        `SELECT id, buyer_name, buyer_phone, buyer_email, invoice_no, amount, currency,
                invoice_date::text AS invoice_date, credit_days, due_date::text AS due_date, status, paid_at,
                last_reminder_at, reminders_sent, note
           FROM org_dues WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      const row = res.rows[0] as (DueRow & { buyer_email: string | null }) | undefined;
      if (!row) return NextResponse.json({ error: 'That item could not be found.' }, { status: 404 });

      const view = describeDue(row, settings, new Date());
      const step = view.step;
      if (step.action !== 'remind') {
        return NextResponse.json({ error: view.cannotRemindBecause || step.reason, step: step.action }, { status: 409 });
      }
      if (!view.channel) return NextResponse.json({ error: 'Add a phone or email for this buyer first.' }, { status: 409 });

      const language = body.language === 'hinglish' ? 'hinglish' : 'en';
      const edited = typeof body.message === 'string' ? body.message.trim().slice(0, 1500) : '';
      const message =
        edited ||
        draftReminder({
          tone: step.tone, buyerName: view.buyerName, invoiceNo: view.invoiceNo, amount: view.amount, dueDate: view.dueDate,
          daysLate: view.daysLate, businessName: String(org.rows[0]?.name || 'Our team'), interest: view.interest,
          msmeRegistered: settings.msmeRegistered, payLink: null, language,
        });
      if (body.preview === true) return NextResponse.json({ message, tone: step.tone, channel: view.channel, reason: step.reason });

      const call =
        view.channel === 'whatsapp'
          ? { tool: 'whatsapp', action: 'send_whatsapp_message', payload: { phone: row.buyer_phone as string, message } }
          : { tool: 'gmail', action: 'send_email', payload: { to: row.buyer_email as string, subject: `Payment reminder${view.invoiceNo ? `: invoice ${view.invoiceNo}` : ''} (${formatRupees(view.amount)})`, body: message } };
      // The message goes out as the workspace's customer-facing employee, the one that already talks to buyers.
      const emp = await client.query(
        `SELECT id FROM ai_employees
          WHERE org_id = $1 AND status = 'active'
          ORDER BY (role ILIKE '%support%') DESC, (role ILIKE '%finance%') DESC, created_at ASC
          LIMIT 1`,
        [orgId],
      );
      const employeeId = emp.rows[0]?.id as string | undefined;
      if (!employeeId) return NextResponse.json({ error: 'Turn on an AI employee first, so there is someone to send the reminder.' }, { status: 409 });
      const result = await executeAutonomousToolAction({
        ...call, orgId, employeeId, actorUserId: userId, source: 'plan',
      });
      if (result.status !== 'pending_approval' && result.status !== 'executed') {
        return NextResponse.json({ error: result.message || 'The reminder could not be prepared.', status: result.status }, { status: 409 });
      }
      await client.query(
        `UPDATE org_dues SET last_reminder_at = NOW(), reminders_sent = reminders_sent + 1, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      return NextResponse.json({
        status: result.status === 'executed' ? 'sent' : 'waiting_for_approval',
        message,
        channel: view.channel,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('POST /api/dues/[id]/remind Error:', err);
    return NextResponse.json({ error: 'Could not prepare that reminder. Please try again.' }, { status: 500 });
  }
}
