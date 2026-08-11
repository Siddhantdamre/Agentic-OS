import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';

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

    const { client, orgId } = await getScopedClient();
    try {
      // Check conversation exists & fetch assigned employee details
      const convRes = await client.query(
        `SELECT c.id, c.channel_id, c.employee_id, e.name as employee_name, e.role as employee_role, e.persona as employee_persona
         FROM conversations c
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

      let aiResponseMsg = null;

      // If user sent the message, trigger AI model response!
      if (role === 'user' || role === 'customer') {
        const empName = conv.employee_name || 'Sarah';
        const empRole = conv.employee_role || 'Sales & Support';
        const empPersona = conv.employee_persona || 'Helpful customer support assistant.';

        const aiResult = await runAutonomousAgentDirect({
            orgId,
            conversationId,
            employeeName: empName,
            employeeRole: empRole,
            employeePersona: empPersona,
            toolAllowlist: ['gmail', 'whatsapp', 'google-calendar', 'hubspot', 'database_query'],
            userMessage: content,
          });

        const aiMsgRes = await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls, created_at)
           VALUES ($1, $2, 'assistant', $3, $4, NOW())
           RETURNING id, org_id, conversation_id, role, content, created_at`,
          [orgId, conversationId, aiResult.replyMessage, JSON.stringify(aiResult.executedSteps)]
        );
        aiResponseMsg = aiMsgRes.rows[0];
      }

      // Update conversation timestamp & summary
      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
        [content.slice(0, 100), conversationId, orgId]
      );

      return NextResponse.json({
        success: true,
        userMessage: userMsgRes.rows[0],
        aiResponse: aiResponseMsg,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Messages POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
