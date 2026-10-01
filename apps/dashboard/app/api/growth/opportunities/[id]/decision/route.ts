import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { startAutonomousAgentWorkflow } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIONS = ['approve', 'reject', 'snooze'] as const;
type DecisionAction = (typeof ACTIONS)[number];

function isAction(value: unknown): value is DecisionAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

function nextStatus(action: DecisionAction): string {
  switch (action) {
    case 'approve':
      return 'in_progress';
    case 'reject':
      return 'cancelled';
    case 'snooze':
      return 'waiting_approval';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * POST /api/growth/opportunities/[id]/decision
 *
 * Human approval gate for growth opportunity cards → outreach.
 * Never auto-sends: outreach starts only when action === 'approve' and a
 * drafted message + recipient email are present on the card metadata.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: workItemId } = await context.params;
    if (!WORK_ITEM_ID.test(workItemId)) {
      return NextResponse.json({ error: 'Invalid opportunity id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    if (!isAction(body.action)) {
      return NextResponse.json(
        { error: 'action must be approve, reject, or snooze' },
        { status: 400 },
      );
    }
    const action: DecisionAction = body.action;
    const draftOverride =
      typeof body.draftOverride === 'string' && body.draftOverride.trim()
        ? body.draftOverride.trim()
        : null;

    const { client, orgId, userId } = await getScopedClient();
    let card: Record<string, unknown> | null = null;
    let status = nextStatus(action);

    try {
      const existing = await client.query<{
        id: string;
        type: string;
        status: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT id, type, status, metadata
           FROM work_items
          WHERE id = $1 AND org_id = $2 AND type = 'growth_opportunity'
          FOR UPDATE`,
        [workItemId, orgId],
      );
      const row = existing.rows[0];
      if (!row) {
        return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
      }

      if (['done', 'cancelled', 'completed'].includes(row.status)) {
        return NextResponse.json(
          { error: `Opportunity already ${row.status}` },
          { status: 409 },
        );
      }

      const metadata = { ...(row.metadata || {}) };
      const rawCard =
        metadata.card && typeof metadata.card === 'object'
          ? (metadata.card as Record<string, unknown>)
          : metadata;
      card = { ...rawCard };
      if (draftOverride && card.draftedMessage && typeof card.draftedMessage === 'object') {
        card.draftedMessage = {
          ...(card.draftedMessage as Record<string, unknown>),
          body: draftOverride,
        };
      } else if (draftOverride) {
        card.draftedMessage = { body: draftOverride };
      }
      card.status = action;
      metadata.card = card;
      metadata.approved_by =
        action === 'approve'
          ? { userId, approvedAt: new Date().toISOString() }
          : metadata.approved_by;

      const dueSql = action === 'snooze' ? `, due_at = NOW() + INTERVAL '1 day'` : '';
      await client.query(
        `UPDATE work_items
            SET status = $1,
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
                ${dueSql}
          WHERE id = $3 AND org_id = $4`,
        [status, JSON.stringify({ card: metadata.card, approved_by: metadata.approved_by || null }), workItemId, orgId],
      );

      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            orgId,
            workItemId,
            action === 'approve' ? 'card_approved' : action === 'reject' ? 'card_rejected' : 'card_snoozed',
            JSON.stringify({ action, decidedBy: userId, source: 'growth_decision_api' }),
            userId,
            `growth:${workItemId}:${action}`,
          ],
        );
      } catch (err: unknown) {
        if (!isMissingTable(err, 'work_events')) {
          console.error('growth decision work_events insert failed:', err);
        }
      }

      try {
        await client.query(
          `INSERT INTO audit_events (
             org_id, kind, actor_type, actor_user_id, work_item_id, approver_user_id,
             action, risk_class, result_status, payload
           ) VALUES ($1, 'confirm.override', 'user', $2, $3, $4, $5, 'high', 'ok', $6::jsonb)`,
          [
            orgId,
            userId,
            workItemId,
            action === 'approve' ? userId : null,
            action === 'approve' ? 'growth.outreach_approved' : `growth.opportunity_${action}`,
            JSON.stringify({ action, requiresHumanApproval: true, source: 'growth_decision_api' }),
          ],
        );
      } catch (err: unknown) {
        if (!isMissingTable(err, 'audit_events')) {
          console.error('growth decision audit_events insert failed:', err);
        }
      }
    } finally {
      client.release();
    }

    // Outreach ONLY after explicit human approve — never on reject/snooze/auto.
    let outreachDispatched = false;
    let outreachBlockedReason: string | null = null;
    if (action === 'approve' && card) {
      const contact =
        card.targetContact && typeof card.targetContact === 'object'
          ? (card.targetContact as Record<string, unknown>)
          : {};
      const draft =
        card.draftedMessage && typeof card.draftedMessage === 'object'
          ? (card.draftedMessage as Record<string, unknown>)
          : {};
      const toEmail = typeof contact.email === 'string' ? contact.email.trim() : '';
      const subject =
        typeof draft.subject === 'string' && draft.subject.trim()
          ? draft.subject.trim()
          : `Quick note regarding ${typeof card.companyName === 'string' ? card.companyName : 'your work'}`;
      const bodyText = typeof draft.body === 'string' ? draft.body.trim() : '';

      if (!toEmail || !bodyText) {
        outreachBlockedReason = !toEmail
          ? 'Missing recipient email on opportunity card'
          : 'Missing drafted message body';
      } else {
        const domain = toEmail.includes('@') ? toEmail.split('@')[1]!.toLowerCase() : '';
        if (domain) {
          try {
            const { client: lockClient } = await getScopedClient();
            try {
              const locked = await lockClient.query(
                `SELECT domain, locked_until FROM outbound_domain_locks
                  WHERE org_id = $1 AND domain = $2 AND locked_until > NOW()`,
                [orgId, domain],
              );
              if (locked.rowCount && locked.rowCount > 0) {
                outreachBlockedReason = `Domain ${domain} is locked until ${locked.rows[0].locked_until}`;
              } else {
                await lockClient.query(
                  `INSERT INTO outbound_domain_locks (org_id, domain, locked_until, work_item_id)
                   VALUES ($1, $2, NOW() + INTERVAL '1 day', $3)
                   ON CONFLICT (org_id, domain) DO UPDATE
                     SET locked_until = EXCLUDED.locked_until,
                         work_item_id = EXCLUDED.work_item_id`,
                  [orgId, domain, workItemId],
                );
              }
            } finally {
              lockClient.release();
            }
          } catch (err: unknown) {
            if (!isMissingTable(err, 'outbound_domain_locks')) {
              console.error('domain lock check failed:', err);
            }
          }
        }

        if (outreachBlockedReason) {
          // skip send
        } else try {
          await startAutonomousAgentWorkflow({
            orgId,
            userId,
            employeeName: 'Growth',
            employeeRole: 'growth',
            employeePersona: 'Growth outreach specialist — send only the approved draft.',
            toolAllowlist: ['gmail'],
            userMessage: `Send an email via gmail send_email to ${toEmail} with subject "${subject}" and this exact body:\n\n${bodyText}`,
            idempotencyKey: `growth-outreach-${workItemId}`,
            skipPersist: true,
          });
          outreachDispatched = true;
          status = 'done';
          const { client: doneClient } = await getScopedClient();
          try {
            await doneClient.query(
              `UPDATE work_items SET status = 'done', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
              [workItemId, orgId],
            );
          } finally {
            doneClient.release();
          }
        } catch (err: unknown) {
          console.error('POST /api/growth/opportunities/[id]/decision outreach Error:', err);
          outreachBlockedReason = err instanceof Error ? err.message : 'Outreach dispatch failed';
        }
      }
    }

    return NextResponse.json({
      ok: true,
      workItemId,
      action,
      status,
      outreachDispatched,
      outreachBlockedReason,
      message:
        action === 'approve'
          ? outreachDispatched
            ? 'Outreach dispatched after human approval'
            : outreachBlockedReason || 'Approved but outreach not dispatched'
          : action === 'snooze'
            ? 'Opportunity snoozed'
            : 'Opportunity dismissed',
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/growth/opportunities/[id]/decision Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
