import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const channel = searchParams.get('channel');
      const status = searchParams.get('status');
      const search = searchParams.get('search');

      let query = `
        SELECT 
          c.id,
          c.org_id,
          c.chatwoot_conv_id,
          c.status,
          c.contact_id,
          c.summary,
          c.metadata,
          c.started_at,
          c.updated_at,
          c.employee_id,
          ch.channel_type,
          e.name as employee_name,
          e.role as employee_role,
          (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT created_at FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY created_at DESC LIMIT 1) as last_message_at,
          (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1) as message_count
        FROM conversations c
        LEFT JOIN channels ch ON c.channel_id = ch.id
        LEFT JOIN ai_employees e ON c.employee_id = e.id
        WHERE c.org_id = $1
      `;

      const params: any[] = [orgId];
      let paramIndex = 2;

      if (channel && channel !== 'all') {
        query += ` AND ch.channel_type = $${paramIndex}`;
        params.push(channel);
        paramIndex++;
      }

      if (status && status !== 'all') {
        query += ` AND c.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (search) {
        query += ` AND (c.contact_id ILIKE $${paramIndex} OR c.summary ILIKE $${paramIndex} OR c.metadata::text ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      query += ` ORDER BY c.updated_at DESC`;

      const res = await client.query(query, params);

      const statsRes = await client.query(
        `SELECT status, count(*) as count FROM conversations WHERE org_id = $1 GROUP BY status`,
        [orgId]
      );

      const channelStatsRes = await client.query(
        `SELECT ch.channel_type, count(c.id) as count 
         FROM conversations c 
         JOIN channels ch ON c.channel_id = ch.id 
         WHERE c.org_id = $1 
         GROUP BY ch.channel_type`,
        [orgId]
      );

      const stats = {
        total: 0,
        open: 0,
        resolved: 0,
        pending_human: 0,
        channels: {} as Record<string, number>,
      };

      statsRes.rows.forEach((row) => {
        const count = parseInt(row.count, 10);
        stats.total += count;
        if (row.status === 'open') stats.open += count;
        if (row.status === 'resolved') stats.resolved += count;
        if (row.status === 'pending_human' || row.status === 'needs_attention') stats.pending_human += count;
      });

      channelStatsRes.rows.forEach((row) => {
        stats.channels[row.channel_type] = parseInt(row.count, 10);
      });

      return NextResponse.json({
        conversations: res.rows,
        stats,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Conversations GET Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { contactId, channelType, employeeId, initialMessage } = body;

      const contact = contactId || `Customer ${Math.floor(100 + Math.random() * 900)}`;

      // Get or create channel ID
      let channelId = null;
      if (channelType) {
        const chanRes = await client.query(
          `SELECT id FROM channels WHERE org_id = $1 AND channel_type = $2 LIMIT 1`,
          [orgId, channelType]
        );
        if (chanRes.rows.length > 0) {
          channelId = chanRes.rows[0].id;
        } else {
          const newChan = await client.query(
            `INSERT INTO channels (org_id, channel_type, name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
            [orgId, channelType, `${channelType.toUpperCase()} Channel`]
          );
          channelId = newChan.rows[0].id;
        }
      }

      // Pick active employee
      let assignedEmployeeId = employeeId;
      let empName = 'AI Assistant';
      let empRole = 'General Assistant';
      let empPersona = 'A helpful business AI assistant.';
      let empToolAllowlist: string[] = [];

      if (assignedEmployeeId) {
        const empRes = await client.query(
          'SELECT id, name, role, persona, tool_allowlist FROM ai_employees WHERE id = $1 AND org_id = $2',
          [assignedEmployeeId, orgId]
        );
        if (empRes.rows.length > 0) {
          empName = empRes.rows[0].name;
          empRole = empRes.rows[0].role;
          empPersona = empRes.rows[0].persona || empPersona;
          try {
            empToolAllowlist = typeof empRes.rows[0].tool_allowlist === 'string'
              ? JSON.parse(empRes.rows[0].tool_allowlist)
              : (empRes.rows[0].tool_allowlist ?? []);
          } catch { empToolAllowlist = []; }
        }
      } else {
        const empRes = await client.query(
          `SELECT id, name, role, persona, tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`,
          [orgId]
        );
        if (empRes.rows.length > 0) {
          assignedEmployeeId = empRes.rows[0].id;
          empName = empRes.rows[0].name;
          empRole = empRes.rows[0].role;
          empPersona = empRes.rows[0].persona || empPersona;
          try {
            empToolAllowlist = typeof empRes.rows[0].tool_allowlist === 'string'
              ? JSON.parse(empRes.rows[0].tool_allowlist)
              : (empRes.rows[0].tool_allowlist ?? []);
          } catch { empToolAllowlist = []; }
        }
      }

      const convRes = await client.query(
        `INSERT INTO conversations (org_id, contact_id, channel_id, employee_id, status, summary, started_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW())
         RETURNING id, org_id, contact_id, status, summary, created_at`,
        [orgId, contact, channelId, assignedEmployeeId, initialMessage ? initialMessage.slice(0, 100) : 'New conversation']
      );

      const conversation = convRes.rows[0];

      if (initialMessage && initialMessage.trim()) {
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
           VALUES ($1, $2, 'user', $3, NOW())`,
          [orgId, conversation.id, initialMessage]
        );

        // Call AI model (atomic-agent)
        const aiResult = await runAutonomousAgentDirect(
          {
            orgId,
            conversationId: conversation.id,
            employeeName: empName,
            employeeRole: empRole,
            employeePersona: empPersona,
            toolAllowlist: empToolAllowlist,
            userMessage: initialMessage,
          }
        );

        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
           VALUES ($1, $2, 'assistant', $3, NOW())`,
          [orgId, conversation.id, aiResult.replyMessage]
        );
      }

      return NextResponse.json({ success: true, conversation });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Conversations POST Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
