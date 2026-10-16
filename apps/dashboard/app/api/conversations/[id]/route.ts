import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { realtimeHub } from '@/lib/realtime-hub';
import { canActOnConversations, loadHumanRole } from '@/lib/rbac';
import { auditConversationAction } from '@/lib/conversation-audit';
import { startMemoryWriteBackWorkflow, signalNurtureCancelled } from '@darex/workflows/dist/workflow-client';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const { id: conversationId } = await params;
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const status = typeof body.status === 'string' ? body.status : undefined;
      const employee_id =
        typeof body.employee_id === 'string'
          ? body.employee_id
          : body.employee_id === null
            ? null
            : undefined;
      const assigned_user_id =
        typeof body.assigned_user_id === 'string'
          ? body.assigned_user_id
          : body.assignedUserId === null || body.assigned_user_id === null
            ? null
            : typeof body.assignedUserId === 'string'
              ? body.assignedUserId
              : undefined;
      const pauseAi =
        typeof body.pauseAi === 'boolean'
          ? body.pauseAi
          : typeof body.ai_paused === 'boolean'
            ? body.ai_paused
            : typeof body.aiPaused === 'boolean'
              ? body.aiPaused
              : undefined;
      const durationHoursRaw = body.durationHours ?? body.duration_hours;
      const durationHours =
        typeof durationHoursRaw === 'number' && Number.isFinite(durationHoursRaw)
          ? Math.min(Math.max(durationHoursRaw, 1), 168)
          : 24;

      // Clearing the unread badge is a read-side action; everything else changes
      // what the customer experiences and needs an operator role (CH-S05).
      const mutates =
        status !== undefined ||
        employee_id !== undefined ||
        assigned_user_id !== undefined ||
        pauseAi !== undefined;
      if (mutates && !canActOnConversations(await loadHumanRole(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      if (
        status !== undefined &&
        !['open', 'resolved', 'closed', 'needs_attention', 'pending_human'].includes(status)
      ) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }

      const updates: string[] = ['updated_at = NOW()'];
      const queryParams: unknown[] = [conversationId, orgId];
      let idx = 3;

      if (status) {
        updates.push(`status = $${idx}`);
        queryParams.push(status);
        idx++;
        if (status === 'resolved') {
          updates.push(`resolved_at = NOW()`);
        }
      }

      if (employee_id !== undefined) {
        updates.push(`employee_id = $${idx}`);
        queryParams.push(employee_id);
        idx++;
      }

      if (assigned_user_id !== undefined) {
        updates.push(`assigned_user_id = $${idx}`);
        queryParams.push(assigned_user_id);
        idx++;
      }

      if (pauseAi === true) {
        updates.push(`ai_paused = true`);
        updates.push(`ai_paused_until = NOW() + ($${idx} || ' hours')::interval`);
        queryParams.push(String(durationHours));
        idx++;
      } else if (pauseAi === false) {
        updates.push(`ai_paused = false`);
        updates.push(`ai_paused_until = NULL`);
      }

      if (body.clearUnread === true) {
        updates.push(`unread_count = 0`);
      }

      const query = `
        UPDATE conversations
        SET ${updates.join(', ')}
        WHERE id = $1 AND org_id = $2
        RETURNING *
      `;

      const res = await client.query(query, queryParams);

      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      const row = res.rows[0];
      const scoped = { client, orgId };
      if (pauseAi !== undefined) {
        await auditConversationAction(scoped, {
          userId,
          kind: 'conversation.takeover',
          conversationId,
          payload: { aiPaused: pauseAi, durationHours: pauseAi ? durationHours : null },
        });
      }
      if (status === 'resolved' || status === 'closed') {
        await auditConversationAction(scoped, {
          userId,
          kind: 'conversation.resolve',
          conversationId,
          payload: { status },
        });
      }
      if (assigned_user_id !== undefined || employee_id !== undefined) {
        await auditConversationAction(scoped, {
          userId,
          kind: 'conversation.assign',
          conversationId,
          payload: {
            ...(assigned_user_id !== undefined ? { assignedUserId: assigned_user_id } : {}),
            ...(employee_id !== undefined ? { employeeId: employee_id } : {}),
          },
        });
      }
      realtimeHub.publish(orgId, {
        type: pauseAi !== undefined ? 'conversation_takeover_updated' : 'conversation_updated',
        conversationId,
        channelType: row.channel_type || 'unknown',
        message:
          pauseAi === true
            ? 'AI paused (human takeover)'
            : pauseAi === false
              ? 'AI resumed'
              : undefined,
      });

      if (status === 'resolved' || status === 'closed') {
        void startMemoryWriteBackWorkflow({
          orgId,
          conversationId,
          closed: true,
          businessKey: `closed:${conversationId}`,
        });
        void signalNurtureCancelled({
          orgId,
          conversationId,
          reason: 'takeover',
        });
      }

      return NextResponse.json({
        success: true,
        conversation: row,
        pausedBy: pauseAi === true ? userId : undefined,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const errorId = randomUUID();
    console.error('Conversation PATCH Error:', errorId, err);
    return NextResponse.json({ error: 'Internal error', errorId }, { status: 500 });
  }
}
