import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import type { PoolClient } from 'pg';
import { employeePersonaText, fireInboundAgent, parseToolAllowlist } from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta } from '@/lib/channel-outbound';
import { canActOnConversations, loadHumanRole } from '@/lib/rbac';
import { auditConversationAction } from '@/lib/conversation-audit';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || String(DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), MAX_PAGE_SIZE);
}

function parseCursor(raw: string | null): { updatedAt: string; id: string } | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf('_');
  if (sep <= 0 || sep === raw.length - 1) return null;
  const updatedAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { updatedAt: new Date(ts).toISOString(), id };
}

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const channel = searchParams.get('channel');
      const status = searchParams.get('status');
      const search = searchParams.get('search');
      const limit = parseLimit(searchParams.get('limit'));
      const cursor = parseCursor(searchParams.get('cursor'));

      const params: unknown[] = [orgId];
      let paramIndex = 2;

      let channelClause = '';
      if (channel && channel !== 'all') {
        channelClause = ` AND (
          ch.channel_type = $${paramIndex}
          OR EXISTS (
            SELECT 1 FROM messages mk
             WHERE mk.conversation_id = c.id
               AND mk.org_id = $1
               AND mk.channel_key = $${paramIndex}
          )
        )`;
        params.push(channel);
        paramIndex++;
      }

      let statusClause = '';
      if (status && status !== 'all') {
        // Inbox "Needs Attention" rolls up both legacy pending_human and needs_attention
        // (same union as the stats.pending_human counter below).
        if (status === 'needs_attention' || status === 'pending_human') {
          statusClause = ` AND c.status IN ('needs_attention', 'pending_human')`;
        } else {
          statusClause = ` AND c.status = $${paramIndex}`;
          params.push(status);
          paramIndex++;
        }
      }

      let searchClause = '';
      if (search) {
        searchClause = ` AND (
          c.contact_id ILIKE $${paramIndex} ESCAPE '\\'
          OR c.summary ILIKE $${paramIndex} ESCAPE '\\'
          OR c.metadata->>'sender_name' ILIKE $${paramIndex} ESCAPE '\\'
          OR c.metadata->>'phone' ILIKE $${paramIndex} ESCAPE '\\'
          OR c.metadata->>'email' ILIKE $${paramIndex} ESCAPE '\\'
        )`;
        params.push(`%${escapeLike(search)}%`);
        paramIndex++;
      }

      let cursorClause = '';
      if (cursor) {
        cursorClause = ` AND (c.updated_at, c.id) < ($${paramIndex}::timestamptz, $${paramIndex + 1}::uuid)`;
        params.push(cursor.updatedAt, cursor.id);
        paramIndex += 2;
      }

      const limitParam = paramIndex;
      params.push(limit + 1);

      const query = `
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
          c.ai_paused,
          c.ai_paused_until,
          c.assigned_user_id,
          COALESCE(c.unread_count, 0) AS unread_count,
          c.sla_deadline_at,
          ch.channel_type,
          e.name as employee_name,
          e.role as employee_role,
          lm.content as last_message,
          lm.created_at as last_message_at,
          COALESCE(lm.message_count, 0) as message_count
        FROM conversations c
        LEFT JOIN channels ch ON c.channel_id = ch.id
        LEFT JOIN ai_employees e ON c.employee_id = e.id
        LEFT JOIN LATERAL (
          SELECT
            m.content,
            m.created_at,
            COUNT(*) OVER()::int AS message_count
          FROM messages m
          WHERE m.conversation_id = c.id AND m.org_id = $1
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) lm ON true
        WHERE c.org_id = $1
        ${channelClause}
        ${statusClause}
        ${searchClause}
        ${cursorClause}
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $${limitParam}
      `;

      const res = await client.query(query, params);

      const hasMore = res.rows.length > limit;
      const conversations = hasMore ? res.rows.slice(0, limit) : res.rows;
      const last = conversations[conversations.length - 1];
      const nextCursor =
        hasMore && last?.updated_at && last?.id
          ? `${new Date(last.updated_at).toISOString()}_${last.id}`
          : null;

      const statsRes = await client.query(
        `SELECT status, count(*) as count FROM conversations WHERE org_id = $1 GROUP BY status`,
        [orgId]
      );

      const channelStatsRes = await client.query(
        `SELECT ch.channel_type, count(c.id) as count
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
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
        conversations,
        nextCursor,
        stats,
      });
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const errorId = randomUUID();
    console.error('Conversations GET Error:', errorId, err);
    return NextResponse.json({ error: 'Internal error', errorId }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client: clientPool, orgId, userId } = await getScopedClient();
    let client: PoolClient | null = clientPool;
    try {
      if (!canActOnConversations(await loadHumanRole(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const { contactId, channelType, employeeId, initialMessage } = body as {
        contactId?: unknown; channelType?: unknown; employeeId?: unknown; initialMessage?: unknown;
      };

      const contact =
        typeof contactId === 'string' && contactId.trim()
          ? contactId.trim().slice(0, 200)
          : `Unnamed contact ${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

      // Get or create channel ID
      let channelId = null;
      const channelTypeStr = typeof channelType === 'string' && channelType.trim() ? channelType.trim().slice(0, 50) : null;
      if (channelTypeStr) {
        const chanRes = await client.query(
          `SELECT id FROM channels WHERE org_id = $1 AND channel_type = $2 LIMIT 1`,
          [orgId, channelTypeStr]
        );
        if (chanRes.rows.length > 0) {
          channelId = chanRes.rows[0].id;
        } else {
          const newChan = await client.query(
            `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
             VALUES ($1, $2, 'active', $3, NOW()) RETURNING id`,
            [orgId, channelTypeStr, JSON.stringify({ name: `${channelTypeStr} Channel` })]
          );
          channelId = newChan.rows[0].id;
          await auditConversationAction(
            { client, orgId },
            { userId, kind: 'channel.create', payload: { channelId, channelType: channelTypeStr } }
          );
        }
      }

      // Pick active employee
      let assignedEmployeeId = typeof employeeId === 'string' && employeeId.trim() ? employeeId : null;
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
          empPersona = employeePersonaText(empRes.rows[0].persona);
          empToolAllowlist = parseToolAllowlist(empRes.rows[0].tool_allowlist, []);
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
          empPersona = employeePersonaText(empRes.rows[0].persona);
          empToolAllowlist = parseToolAllowlist(empRes.rows[0].tool_allowlist, []);
        }
      }

      const initialMessageStr =
        typeof initialMessage === 'string' && initialMessage.trim() ? initialMessage : null;
      const convRes = await client.query(
        `INSERT INTO conversations (org_id, contact_id, channel_id, employee_id, status, summary, started_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW())
         RETURNING id, org_id, contact_id, status, summary, created_at`,
        [orgId, contact, channelId, assignedEmployeeId, initialMessageStr ? initialMessageStr.slice(0, 100) : 'New conversation']
      );

      const conversation = convRes.rows[0];

      if (initialMessageStr) {
        await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
           VALUES ($1, $2, 'user', $3, NOW())`,
          [orgId, conversation.id, initialMessageStr]
        );

        const connectedRes = await client.query(
          `SELECT channel_type, meta FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
          [orgId]
        );
        const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);
        const chanMetaRow = connectedRes.rows.find((row: { channel_type: string }) => row.channel_type === channelTypeStr);

        client.release();
        client = null;

        fireInboundAgent({
          orgId,
          conversationId: conversation.id,
          channelId: channelId ?? undefined,
          employeeId: assignedEmployeeId ?? undefined,
          employeeName: empName,
          employeeRole: empRole,
          employeePersona: empPersona,
          toolAllowlist: empToolAllowlist,
          connectedChannels,
          userMessage: initialMessageStr,
          replyTarget: replyTargetFromChannelMeta(
            channelTypeStr || 'dashboard',
            contact,
            (chanMetaRow?.meta || {}) as Record<string, unknown>
          ),
        });
      }

      return NextResponse.json({ success: true, conversation });
    } finally {
      if (client) client.release();
    }
  } catch (err: unknown) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const errorId = randomUUID();
    console.error('Conversations POST Error:', errorId, err);
    return NextResponse.json({ error: 'Internal error', errorId }, { status: 500 });
  }
}
