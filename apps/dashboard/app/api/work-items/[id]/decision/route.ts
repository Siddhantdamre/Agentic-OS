import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';
import {
  getTemporalClient,
  signalWorkItemDecision,
  startAutonomousAgentWorkflow,
} from '@darex/workflows/dist/workflow-client';
import { mergePreferenceRules, ruleFromRejection } from '@darex/workflows/dist/growth/preferences';
import { decideApproval } from '@/lib/decide-approval';

export const dynamic = 'force-dynamic';

const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DECISIONS = ['approve', 'reject', 'snooze', 'modify'] as const;
type DecisionAction = (typeof DECISIONS)[number];

const REASONS = ['wrong_fit', 'wrong_timing', 'wrong_channel', 'just_not_now'] as const;
type ReasonCode = (typeof REASONS)[number];

function isDecision(value: unknown): value is DecisionAction {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value);
}

function isReason(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASONS as readonly string[]).includes(value);
}

function canDecideWorkItem(role: HumanRole, action: DecisionAction): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
      return action === 'snooze';
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

function eventKind(action: DecisionAction): 'card_approved' | 'card_rejected' | 'card_snoozed' | 'card_modified' {
  switch (action) {
    case 'approve':
      return 'card_approved';
    case 'reject':
      return 'card_rejected';
    case 'snooze':
      return 'card_snoozed';
    case 'modify':
      return 'card_modified';
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function nextStatus(action: DecisionAction): string {
  switch (action) {
    case 'approve':
    case 'modify':
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

async function writeSuppression(
  client: Awaited<ReturnType<typeof getScopedClient>>['client'],
  orgId: string,
  workItemId: string,
  reason: ReasonCode,
  patternKey: string
): Promise<void> {
  if (reason === 'just_not_now') return;
  const dimension =
    reason === 'wrong_fit' ? 'fit' : reason === 'wrong_timing' ? 'timing' : 'channel';
  try {
    await client.query(
      `INSERT INTO org_preferences (org_id, rules, suppressions, updated_at)
       VALUES ($1, '[]'::jsonb, $2::jsonb, NOW())
       ON CONFLICT (org_id) DO UPDATE SET
         suppressions = COALESCE(org_preferences.suppressions, '[]'::jsonb) || EXCLUDED.suppressions,
         updated_at = NOW()`,
      [orgId, JSON.stringify([{ reason, workItemId, patternKey, dimension }])]
    );
  } catch (err: unknown) {
    if (!isMissingTable(err, 'org_preferences')) throw err;
  }
  try {
    await client.query(
      `INSERT INTO agent_preference_suppressions
         (org_id, employee_role, dimension, pattern_key, rejection_count)
       VALUES ($1, 'growth', $2, $3, 1)
       ON CONFLICT (org_id, employee_role, dimension, pattern_key)
       DO UPDATE SET
         rejection_count = agent_preference_suppressions.rejection_count + 1,
         last_rejected_at = NOW(),
         weight = 1,
         dismissed_by_user = FALSE`,
      [orgId, dimension, patternKey]
    );
  } catch (err: unknown) {
    if (!isMissingTable(err, 'agent_preference_suppressions')) throw err;
  }
}

/**
 * POST /api/work-items/[id]/decision — one-tap owner decision.
 * Org comes from the session. Body org_id is rejected.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: workItemId } = await context.params;
    if (!WORK_ITEM_ID.test(workItemId)) {
      return NextResponse.json({ error: 'Invalid work item id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const actionRaw = body.action ?? body.decision;
    if (!isDecision(actionRaw)) {
      return NextResponse.json({ error: 'action must be approve, reject, snooze, or modify' }, { status: 400 });
    }
    const action: DecisionAction = actionRaw;
    const reason = isReason(body.reason) ? body.reason : undefined;
    const optionId = typeof body.optionId === 'string' ? body.optionId : undefined;
    const modifiedArgs =
      body.modifiedArgs && typeof body.modifiedArgs === 'object'
        ? (body.modifiedArgs as Record<string, unknown>)
        : undefined;

    // Decision cards parked by autonomy have no Temporal workflow; they are
    // backed by an agent_pending_actions row. Route them through the shared
    // decision path so approving here executes and audits exactly like
    // /api/decisions instead of only flipping the work item status.
    if (action === 'approve' || action === 'reject' || action === 'modify') {
      const pre = await getScopedClient();
      let pendingActionId: string | null = null;
      try {
        const linked = await pre.client.query<{ id: string }>(
          `SELECT pa.id
             FROM agent_pending_actions pa
             JOIN work_items wi ON wi.id = pa.work_item_id AND wi.org_id = pa.org_id
            WHERE pa.work_item_id = $1 AND pa.org_id = $2
              AND wi.type = 'decision' AND wi.temporal_workflow_id IS NULL
            ORDER BY pa.created_at DESC
            LIMIT 1`,
          [workItemId, pre.orgId]
        );
        pendingActionId = linked.rows[0]?.id ?? null;
      } catch (err: unknown) {
        if (!isMissingTable(err, 'agent_pending_actions')) throw err;
      } finally {
        pre.client.release();
      }
      if (pendingActionId) {
        const result = await decideApproval({
          pendingActionId,
          decision: action === 'reject' ? 'rejected' : 'approved',
          actorUserId: pre.userId,
          orgId: pre.orgId,
          modifiedPayload: action === 'modify' ? modifiedArgs ?? null : null,
        });
        if (!result.ok) {
          return NextResponse.json({ error: result.error, workItemId }, { status: result.httpStatus });
        }
        realtimeHub.publish(pre.orgId, { type: 'work_item_updated', message: workItemId });
        return NextResponse.json(
          {
            ok: result.status !== 'execution_failed',
            workItemId,
            action,
            pendingActionId,
            status: result.status,
            ...(result.awaitingApprovals !== undefined ? { awaitingApprovals: result.awaitingApprovals } : {}),
            ...(result.error ? { error: result.error } : {}),
          },
          { status: result.status === 'execution_failed' ? 500 : 200 }
        );
      }
    }

    const { client, orgId, userId } = await getScopedClient();
    let workflowId: string | null = null;
    let growthOpportunityCard: Record<string, unknown> | null = null;
    let status = nextStatus(action);
    let previousStatus = 'waiting_approval';
    try {
      const role = await loadHumanRole(client, userId);
      if (!canDecideWorkItem(role, action)) {
        return NextResponse.json(
          { error: 'Forbidden: auditors cannot approve or reject live work items' },
          { status: 403 }
        );
      }

      const existing = await client.query<{
        id: string;
        type: string;
        status: string;
        temporal_workflow_id: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT id, type, status, temporal_workflow_id, metadata
           FROM work_items WHERE id = $1 AND org_id = $2`,
        [workItemId, orgId]
      );
      const row = existing.rows[0];
      if (!row) {
        return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
      }

      previousStatus = row.status;
      // Concurrent approvals: only one request may claim a waiting_approval / open item.
      if (action === 'approve' || action === 'reject' || action === 'modify') {
        if (row.status !== 'waiting_approval' && row.status !== 'needs_attention' && row.status !== 'open') {
          return NextResponse.json(
            { error: `Work item cannot be decided from status ${row.status}` },
            { status: 409 }
          );
        }
      }

      workflowId = row.temporal_workflow_id;
      growthOpportunityCard =
        row.type === 'growth_opportunity' && row.metadata?.card && typeof row.metadata.card === 'object'
          ? (row.metadata.card as Record<string, unknown>)
          : null;
      const metadata = { ...(row.metadata || {}) };
      if (action === 'modify' && modifiedArgs) {
        metadata.modifiedArgs = modifiedArgs;
      }
      if (optionId) metadata.chosenOptionId = optionId;
      metadata.card = {
        ...((metadata.card && typeof metadata.card === 'object' ? metadata.card : {}) as Record<string, unknown>),
        status: action,
        ...(modifiedArgs ? { modifiedArgs } : {}),
      };

      const dueSql = action === 'snooze' ? `, due_at = NOW() + INTERVAL '1 day'` : '';
      const metadataPatch: Record<string, unknown> = {
        card: metadata.card,
        chosenOptionId: optionId || null,
      };
      if (action === 'modify' && modifiedArgs) {
        metadataPatch.modifiedArgs = modifiedArgs;
      }
      const locked = await client.query(
        `UPDATE work_items
            SET status = $1,
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
                ${dueSql}
          WHERE id = $3 AND org_id = $4 AND status = $5
          RETURNING id`,
        [status, JSON.stringify(metadataPatch), workItemId, orgId, previousStatus]
      );
      if (locked.rowCount === 0) {
        return NextResponse.json(
          { error: 'Work item was already decided by another operator' },
          { status: 409 }
        );
      }

      const kind = eventKind(action);
      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)
           ON CONFLICT DO NOTHING`,
          [
            orgId,
            workItemId,
            kind,
            JSON.stringify({
              action,
              reason: reason || null,
              optionId: optionId || null,
              decidedBy: userId,
              ...(action === 'modify' && modifiedArgs ? { modifiedArgs } : {}),
            }),
            userId,
            `card:${workItemId}:${kind}:${action}`,
          ]
        );
      } catch (err: unknown) {
        if (!isMissingTable(err, 'work_events')) {
          console.error('work_events insert failed:', err);
        }
      }

      if (reason === 'wrong_fit') {
        const card = (metadata.card || {}) as Record<string, unknown>;
        const patternKey =
          (typeof card.companyDomain === 'string' && card.companyDomain) ||
          (typeof card.companyName === 'string' && card.companyName) ||
          workItemId;
        await writeSuppression(client, orgId, workItemId, reason, String(patternKey));
      }

      if (reason && row.type === 'growth_opportunity') {
        const card = (metadata.card || {}) as Record<string, unknown>;
        const rule = ruleFromRejection(reason, {
          industry: typeof card.industry === 'string' ? card.industry : undefined,
          geo: typeof card.geo === 'string' ? card.geo : undefined,
          companyName: typeof card.companyName === 'string' ? card.companyName : undefined,
        });
        if (rule) {
          try {
            const existingRules = await client.query<{ rules: unknown }>(
              `SELECT rules FROM org_preferences WHERE org_id = $1 LIMIT 1`,
              [orgId]
            );
            const current = Array.isArray(existingRules.rows[0]?.rules)
              ? (existingRules.rows[0]!.rules as Parameters<typeof mergePreferenceRules>[0])
              : [];
            const merged = mergePreferenceRules(current, [rule]);
            await client.query(
              `INSERT INTO org_preferences (org_id, rules, updated_at)
               VALUES ($1, $2::jsonb, NOW())
               ON CONFLICT (org_id) DO UPDATE SET rules = EXCLUDED.rules, updated_at = NOW()`,
              [orgId, JSON.stringify(merged)]
            );
          } catch (err: unknown) {
            if (!isMissingTable(err, 'org_preferences')) throw err;
          }
        }
      }
    } finally {
      // Release before Temporal signal — never hold a pooled client across the network call.
      client.release();
    }

    if (workflowId && (action === 'approve' || action === 'reject' || action === 'modify')) {
      try {
        const temporal = await getTemporalClient();
        if (!temporal) {
          throw new Error('Temporal is unavailable');
        }
        // Workflows client currently signals approveWorkItem(optionId). Embed
        // modifiedArgs in optionId so human edits reach the running workflow.
        const signalOptionId =
          action === 'modify' && modifiedArgs
            ? JSON.stringify({ optionId: optionId || 'approved', modifiedArgs })
            : optionId;
        const signalPayload: Parameters<typeof signalWorkItemDecision>[0] & {
          modifiedArgs?: Record<string, unknown>;
        } = {
          workflowId,
          decision: action === 'reject' ? 'rejected' : 'approved',
          optionId: signalOptionId,
          ...(action === 'modify' && modifiedArgs ? { modifiedArgs } : {}),
        };
        await signalWorkItemDecision(signalPayload);
      } catch (signalErr: unknown) {
        // Compensate Postgres so UI does not show approved while Temporal never woke.
        const { client: compensateClient } = await getScopedClient();
        try {
          await compensateClient.query(
            `UPDATE work_items
                SET status = $1, updated_at = NOW()
              WHERE id = $2 AND org_id = $3`,
            [previousStatus, workItemId, orgId]
          );
          try {
            await compensateClient.query(
              `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
               VALUES ($1, $2, 'signal_failed', $3::jsonb, $4, $5)
               ON CONFLICT DO NOTHING`,
              [
                orgId,
                workItemId,
                JSON.stringify({
                  action,
                  previousStatus,
                  error: signalErr instanceof Error ? signalErr.message : String(signalErr),
                }),
                userId,
                `card:${workItemId}:signal_failed:${Date.now()}`,
              ]
            );
          } catch (eventErr: unknown) {
            if (!isMissingTable(eventErr, 'work_events')) {
              console.error('work_events signal_failed insert failed:', eventErr);
            }
          }
        } finally {
          compensateClient.release();
        }
        console.error('POST /api/work-items/[id]/decision Temporal signal Error:', signalErr);
        return NextResponse.json(
          { error: 'Workflow signal failed; decision was reverted', workItemId, status: previousStatus },
          { status: 502 }
        );
      }
    }

    let outreachDispatched = false;
    if (action === 'approve' && !workflowId && growthOpportunityCard) {
      const contact = (growthOpportunityCard.targetContact && typeof growthOpportunityCard.targetContact === 'object'
        ? (growthOpportunityCard.targetContact as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const draft = (growthOpportunityCard.draftedMessage && typeof growthOpportunityCard.draftedMessage === 'object'
        ? (growthOpportunityCard.draftedMessage as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const toEmail = typeof contact.email === 'string' ? contact.email : '';
      const subject = typeof draft.subject === 'string' ? draft.subject : '';
      const body = typeof draft.body === 'string' ? draft.body : '';
      if (toEmail && subject && body) {
        try {
          await startAutonomousAgentWorkflow({
            orgId,
            userId,
            employeeName: 'Growth',
            employeeRole: 'growth',
            employeePersona: 'Autonomous growth outreach specialist.',
            toolAllowlist: ['gmail'],
            userMessage: `Send an email via gmail send_email to ${toEmail} with subject "${subject}" and this exact body:\n\n${body}`,
            idempotencyKey: `growth-outreach-${workItemId}`,
            skipPersist: true,
          });
          outreachDispatched = true;
        } catch (err: unknown) {
          console.error('POST /api/work-items/[id]/decision outreach dispatch Error:', err);
        }
      }
    }

    realtimeHub.publish(orgId, { type: 'work_item_updated', message: workItemId });
    return NextResponse.json({
      ok: true,
      workItemId,
      action,
      status,
      reason: reason || null,
      outreachDispatched,
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/work-items/[id]/decision Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
