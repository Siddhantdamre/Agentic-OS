import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { startMemoryWriteBackWorkflow, signalNurtureCancelled } from '@darex/workflows/dist/workflow-client';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { id: conversationId } = await params;
      const { status, employee_id } = await request.json();

      // getScopedClient already set app.current_org_id for RLS + validated session
      const updates: string[] = ['updated_at = NOW()'];
      const queryParams: any[] = [conversationId, orgId];
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

      realtimeHub.publish(orgId, {
        type: 'conversation_updated',
        conversationId,
        channelType: res.rows[0].channel_type || 'unknown',
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
        conversation: res.rows[0],
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Conversation PATCH Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
