import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import type { PoolClient } from 'pg';

// GET message history for a conversation
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const { client, orgId } = await getScopedClient();
    try {
      const messagesRes = await client.query(
        `SELECT id, org_id, conversation_id, role, content, tool_calls, chatwoot_msg_id, created_at
         FROM messages
         WHERE org_id = $1 AND conversation_id = $2
         ORDER BY created_at ASC`,
        [orgId, conversationId]
      );

      const convRes = await client.query(
        `SELECT c.*, ch.channel_type, e.name as employee_name, e.role as employee_role
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      return NextResponse.json({
        conversation: convRes.rows[0],
        messages: messagesRes.rows,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Messages GET Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST message & trigger AI Model Response (atomic-agent)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const { content, role = 'user' } = await request.json();

    if (!content || !content.trim()) {
      return NextResponse.json({ error: 'Message content is required' }, { status: 400 });
    }

    const { client: clientPool, orgId } = await getScopedClient();
    let client: PoolClient | null = clientPool;
    try {
      // Check conversation exists & fetch assigned employee details
      const convRes = await client.query(
        `SELECT c.id, c.channel_id, c.employee_id, c.contact_id, ch.channel_type, e.name as employee_name, e.role as employee_role, e.persona as employee_persona
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      const conv = convRes.rows[0];
      const chatwootMsgId = Math.floor(100000 + Math.random() * 900000);

      // Insert incoming message
      const userMsgRes = await client.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, org_id, conversation_id, role, content, chatwoot_msg_id, created_at`,
        [orgId, conversationId, role, content, chatwootMsgId]
      );

      // Update conversation timestamp & summary
      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
        [content.slice(0, 100), conversationId, orgId]
      );

      // Publish real-time event (new customer message → needs_attention)
      if (conv.channel_id) {
        realtimeHub.publish(orgId, {
          type: 'needs_attention',
          conversationId,
          message: content.slice(0, 200),
          contactId: conv.contact_id ?? null,
          channelType: conv.channel_type ?? 'dashboard',
        });
      }

      // Release the pooled client BEFORE kicking off the AI turn so the
      // request handler never holds a pool slot while the model runs.
      client.release();
      client = null;

      // If the user sent the message, trigger the AI response WITHOUT
      // blocking the request. Prefer durable Temporal execution; fall back
      // to a background direct atomic-agent turn. Either path persists the
      // assistant reply itself.
      if (role === 'user' || role === 'customer') {
        const empName = conv.employee_name || 'Sarah';
        const empRole = conv.employee_role || 'Sales & Support';
        const empPersona = conv.employee_persona || 'Helpful customer support assistant.';

        const agentInput = {
          orgId,
          conversationId,
          employeeName: empName,
          employeeRole: empRole,
          employeePersona: empPersona,
          toolAllowlist: ['gmail', 'whatsapp', 'google-calendar', 'hubspot', 'database_query'],
          userMessage: content,
        };

        void (async () => {
          try {
            const { startAutonomousAgentWorkflow } = await import('@darex/workflows/dist/workflow-client');
            const handle = await startAutonomousAgentWorkflow(agentInput);
            if (handle) return; // workflow persists the assistant reply via saveMessageActivity
          } catch (temporalErr: any) {
            console.warn('[Messages] Temporal unavailable, direct fallback:', temporalErr.message);
          }
          try {
            const { runAutonomousAgentDirect } = await import('@darex/workflows/dist/atomic-agent-client');
            const aiResult = await runAutonomousAgentDirect(agentInput);
            const pool = (await import('@/lib/db')).pool;
            const pc = await pool.connect();
            try {
              await pc.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
              await pc.query(
                `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls, created_at)
                 VALUES ($1, $2, 'assistant', $3, $4, NOW())`,
                [orgId, conversationId, aiResult.replyMessage, JSON.stringify(aiResult.executedSteps || [])]
              );
            } finally {
              pc.release();
            }
          } catch (agentErr: any) {
            console.error('[Messages] Agent reply error:', agentErr.message);
          }
        })();
      }

      return NextResponse.json({
        success: true,
        userMessage: userMsgRes.rows[0],
        aiResponse: null,
      });
    } finally {
      if (client) client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Messages POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
