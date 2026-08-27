import { NextResponse } from 'next/server';
import { getOrgScopedClient } from '@/lib/db';
import { assertMetaWebhookSignature, verifyMetaSubscribeToken } from '@/lib/webhook-crypto';
import { recordAuditEvent } from '@/lib/inbound-confirm';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';
import {
  isRegisteredOwnerPhone,
  parseOwnerCommand,
  persistInboundMessage,
  resolveChannelByMeta,
  resolveSingleOrgChannel,
  type OwnerCommand,
} from '@/lib/channel-normalize';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { signalPlanDecision, startOwnerBriefingWorkflow } from '@darex/workflows/dist/workflow-client';

/**
 * GET /api/webhooks/owner-whatsapp
 * Distinct number from customer WABA (H5). Mixing numbers is a security bug.
 * H1 token rotation: infra/scripts/OPERATOR_HYGIENE.md §4.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken =
      process.env.OWNER_WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN;

    if (mode === 'subscribe' && verifyMetaSubscribeToken(token, verifyToken)) {
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new NextResponse('Forbidden', { status: 403 });
  } catch (error) {
    console.error('[Owner WhatsApp] GET error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

function inboundText(message: Record<string, unknown>): string {
  const textObj = message.text as { body?: string } | undefined;
  if (typeof textObj?.body === 'string' && textObj.body.trim()) return textObj.body;
  const type = typeof message.type === 'string' ? message.type : 'media';
  return `[${type} message]`;
}

type OwnerJob = {
  orgId: string;
  from: string;
  text: string;
  command: OwnerCommand;
  chanMeta: Record<string, unknown>;
};

async function runOwnerCommand(job: OwnerJob): Promise<string> {
  const command = job.command;
  switch (command.kind) {
    case 'brief': {
      const handle = await startOwnerBriefingWorkflow({
        orgId: job.orgId,
        repeatDaily: false,
        idempotencyKey: `owner-brief:${job.orgId}:${Date.now()}`,
      });
      if (!handle) {
        return 'Could not start briefing (Temporal unavailable). Open the dashboard Home.';
      }
      try {
        const result = (await handle.result()) as { narrative?: string; needsAttention?: number };
        const narrative = (result?.narrative || '').trim();
        const attention =
          typeof result?.needsAttention === 'number' ? `\nNeeds attention: ${result.needsAttention}` : '';
        return narrative ? `${narrative}${attention}` : `Briefing started.${attention}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Briefing failed: ${message}`;
      }
    }
    case 'approve_plan': {
      const { client } = await getOrgScopedClient(job.orgId);
      let workItemWorkflowIds: string[] = [];
      try {
        const existing = (
          await client.query(`SELECT id, status FROM agent_plans WHERE id = $1 AND org_id = $2`, [
            command.planId,
            job.orgId,
          ])
        ).rows[0];
        if (!existing) return `Plan ${command.planId} not found.`;
        if (existing.status !== 'pending') {
          return `Plan must be pending to approve (status: ${existing.status}).`;
        }
        await client.query(
          `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
          [command.planId, job.orgId]
        );
        const ownerRes = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE org_id = $1 AND lower(role) = 'owner' ORDER BY created_at ASC LIMIT 1`,
          [job.orgId]
        );
        const userId = ownerRes.rows[0]?.id ?? null;
        try {
          await recordAuditEvent(
            {
              orgId: job.orgId,
              kind: 'plan.approve',
              actor: userId
                ? { actorType: 'user', userId }
                : { actorType: 'system', component: 'owner-whatsapp' },
              resultStatus: 'ok',
              planId: command.planId,
              approverUserId: userId,
              payload: { planId: command.planId, source: 'owner-whatsapp' },
            },
            { client, orgId: job.orgId }
          );
        } catch (auditErr: unknown) {
          const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
          console.warn('[Owner WhatsApp] audit_events insert failed:', message);
        }
        const waiting = await client.query(
          `SELECT temporal_workflow_id FROM work_items
           WHERE org_id = $1
             AND temporal_workflow_id IS NOT NULL
             AND (metadata->>'planId' = $2 OR status = 'waiting_approval')
           LIMIT 8`,
          [job.orgId, command.planId]
        );
        workItemWorkflowIds = waiting.rows
          .map((r: { temporal_workflow_id?: string }) => r.temporal_workflow_id)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
      } finally {
        client.release();
      }
      await signalPlanDecision({
        orgId: job.orgId,
        planId: command.planId,
        decision: 'approved',
        workItemWorkflowIds,
      });
      return `Approved plan ${command.planId}.`;
    }
    case 'pause_employee': {
      const { client } = await getOrgScopedClient(job.orgId);
      try {
        const res = await client.query(
          `UPDATE ai_employees SET status = 'paused', updated_at = NOW()
           WHERE org_id = $1 AND lower(name) = lower($2)
           RETURNING id, name, status`,
          [job.orgId, command.name]
        );
        if (res.rows.length === 0) {
          return `No employee named "${command.name}" in this org.`;
        }
        return `Paused ${res.rows[0].name}.`;
      } finally {
        client.release();
      }
    }
    case 'unknown':
      return 'Owner commands: "brief me", "approve plan <id>", "pause <employee>". Customer WhatsApp cannot approve payments.';
    default: {
      const _never: never = command;
      return String(_never);
    }
  }
}

/**
 * POST /api/webhooks/owner-whatsapp
 * Persist + 200 first. Owner approve unblocks the same plan id as PlanCard.
 * Customer inbound on the other number cannot invoke these commands.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = assertMetaWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'));
  if (!sig.ok) {
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  if (body.object !== 'whatsapp_business_account') {
    return new NextResponse('OK', { status: 200 });
  }

  const ownerJobs: OwnerJob[] = [];
  const entries = (body.entry as unknown[]) || [];

  for (const entry of entries) {
    const changes = ((entry as { changes?: unknown[] })?.changes) || [];
    for (const change of changes) {
      const value = ((change as { value?: Record<string, unknown> })?.value) || {};
      const messages = (value.messages as Record<string, unknown>[]) || [];
      const metadata = (value.metadata as Record<string, unknown>) || {};
      const phoneNumberId =
        (typeof metadata.phone_number_id === 'string' && metadata.phone_number_id) ||
        process.env.OWNER_WHATSAPP_PHONE_NUMBER_ID ||
        null;

      const customerChannel =
        (await resolveChannelByMeta('whatsapp', 'phone_number_id', phoneNumberId)) ||
        (await resolveChannelByMeta('whatsapp', 'phoneNumberId', phoneNumberId));
      if (customerChannel) {
        console.warn('[Owner WhatsApp] Customer WABA number delivered here — skipping');
        continue;
      }

      const matched =
        (await resolveChannelByMeta('owner_whatsapp', 'phone_number_id', phoneNumberId)) ||
        (await resolveChannelByMeta('owner_whatsapp', 'phoneNumberId', phoneNumberId)) ||
        (await resolveSingleOrgChannel('owner_whatsapp'));

      if (!matched?.org_id) {
        console.error('[Owner WhatsApp] Cannot resolve org for phone_number_id', phoneNumberId);
        continue;
      }

      const webhookLimited = denyWebhookIfLimited(matched.org_id);
      if (webhookLimited) return webhookLimited;

      const chanMeta = {
        ...((matched.meta || {}) as Record<string, unknown>),
        owner_phone:
          (matched.meta as Record<string, unknown> | undefined)?.owner_phone ||
          process.env.OWNER_WHATSAPP_OWNER_PHONE ||
          undefined,
      } as Record<string, unknown>;

      for (const message of messages) {
        const from = typeof message.from === 'string' ? message.from : '';
        const messageId = typeof message.id === 'string' ? message.id : '';
        const text = inboundText(message);
        if (!from) continue;
        if (!isRegisteredOwnerPhone(from, chanMeta)) {
          console.warn('[Owner WhatsApp] Unregistered sender — ignoring commands from', from);
          continue;
        }

        try {
          const persisted = await persistInboundMessage({
            orgId: matched.org_id,
            channelKey: 'owner_whatsapp',
            channelType: 'owner_whatsapp',
            contactId: from,
            content: text,
            providerMessageId: messageId || null,
            skipAgent: true,
            extraMeta: { phone_number_id: phoneNumberId, owner: true },
          });
          if (!persisted.inserted) continue;
          ownerJobs.push({
            orgId: matched.org_id,
            from,
            text,
            command: parseOwnerCommand(text),
            chanMeta: { ...chanMeta, ...persisted.chanMeta },
          });
        } catch (err: unknown) {
          if (isRateLimitError(err)) return responseFromRateLimit(err);
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[Owner WhatsApp] persist error:', msg);
        }
      }
    }
  }

  for (const job of ownerJobs) {
    void (async () => {
      const reply = await runOwnerCommand(job);
      const target = replyTargetFromChannelMeta('whatsapp', job.from, job.chanMeta);
      const sendResult = await sendChannelReply(job.orgId, target, reply);
      if (job.chanMeta && sendResult.attempted && !sendResult.sent) {
        console.warn('[Owner WhatsApp] outbound not sent (revoked Meta ≠ success):', sendResult.message);
      }
    })();
  }

  return new NextResponse('OK', { status: 200 });
}
