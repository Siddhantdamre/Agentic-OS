import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { canApproveActions, loadHumanRole } from '@/lib/rbac';
import { appointedDay } from '@/lib/dues-engine';
import { parseDuesPaste } from '@/lib/dues-text';
import { describeDue, readDuesSettings, totalsOf, type DueRow } from '@/lib/dues-view';

export const dynamic = 'force-dynamic';

const MAX_PASTE_CHARS = 50_000;

/** Money owed to this workspace: every due with its days late, interest and next step, plus the totals. */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const org = await client.query(`SELECT name, meta FROM orgs WHERE id = $1`, [orgId]);
      const settings = readDuesSettings(org.rows[0]?.meta);
      const res = await client.query(
        `SELECT id, buyer_name, buyer_phone, buyer_email, invoice_no, amount, currency,
                invoice_date::text AS invoice_date, credit_days, due_date::text AS due_date, status, paid_at,
                last_reminder_at, reminders_sent, note
           FROM org_dues
          WHERE org_id = $1
          ORDER BY (status = 'paid'), due_date ASC, created_at ASC
          LIMIT 500`,
        [orgId],
      );
      const asOf = new Date();
      const dues = (res.rows as DueRow[]).map((r) => describeDue(r, settings, asOf));
      return NextResponse.json({ businessName: org.rows[0]?.name ?? '', settings, dues, totals: totalsOf(dues) });
    } finally {
      client.release();
    }
  } catch (err) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('GET /api/dues Error:', err);
    return NextResponse.json({ error: 'Could not load what is owed to you. Please try again.' }, { status: 500 });
  }
}

/** Adds dues from a pasted list: { text }. Lines it cannot read are reported by line; the rest are saved. */
export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });

      const role = await loadHumanRole(client, userId);
      if (!canApproveActions(role)) {
        return NextResponse.json({ error: 'Only an owner, admin or manager can add what is owed to you.' }, { status: 403 });
      }
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) return NextResponse.json({ error: 'Paste your list first: one buyer per line.' }, { status: 400 });
      if (text.length > MAX_PASTE_CHARS) return NextResponse.json({ error: 'That list is too long. Paste up to 200 lines at a time.' }, { status: 400 });

      const parsed = parseDuesPaste(text, new Date());
      let added = 0;
      for (const r of parsed.rows) {
        const invoiceDate = new Date(`${r.invoiceDate}T00:00:00.000Z`);
        const due = appointedDay(invoiceDate, r.creditDays).toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO org_dues (org_id, buyer_name, buyer_phone, invoice_no, amount, invoice_date, credit_days, due_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [orgId, r.buyerName.slice(0, 200), r.buyerPhone, r.invoiceNo ? r.invoiceNo.slice(0, 80) : null, r.amount, r.invoiceDate, r.creditDays, due, userId],
        );
        added += 1;
      }
      return NextResponse.json({ added, problems: parsed.problems }, { status: added > 0 || parsed.problems.length === 0 ? 200 : 422 });
    } finally {
      client.release();
    }
  } catch (err) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('POST /api/dues Error:', err);
    return NextResponse.json({ error: 'Could not save that list. Please try again.' }, { status: 500 });
  }
}
