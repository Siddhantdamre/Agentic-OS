import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import crypto from 'crypto';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const ASK_AI_CONTACT_PREFIX = 'ask-ai:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
    let res;
    try {
      res = await client.query(
        `SELECT 
           c.id,
           c.summary,
           c.started_at,
           c.created_at,
           c.updated_at,
           c.ask_mode,
           c.ask_employee_ids,
           (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.org_id = c.org_id) as message_count
         FROM conversations c
         WHERE c.org_id = $1 
           AND (c.contact_id = $2 OR (c.metadata->>'userId' = $3 AND c.metadata->>'source' = 'ask-ai'))
         ORDER BY c.updated_at DESC
         LIMIT 100`,
        [orgId, contactId, userId]
      );
    } catch (colErr: any) {
      if (colErr?.code !== '42703') throw colErr;
      res = await client.query(
        `SELECT 
           c.id,
           c.summary,
           c.started_at,
           c.created_at,
           c.updated_at,
           (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.org_id = c.org_id) as message_count
         FROM conversations c
         WHERE c.org_id = $1 
           AND (c.contact_id = $2 OR (c.metadata->>'userId' = $3 AND c.metadata->>'source' = 'ask-ai'))
         ORDER BY c.updated_at DESC
         LIMIT 100`,
        [orgId, contactId, userId]
      );
    }

    return NextResponse.json({
      conversations: res.rows.map((row: any) => ({
        id: row.id,
        summary: row.summary || 'New Chat',
        created_at: row.created_at,
        updated_at: row.updated_at,
        message_count: Number(row.message_count || 0),
        askMode: row.ask_mode || 'auto',
        askEmployeeIds: Array.isArray(row.ask_employee_ids)
          ? row.ask_employee_ids.map((id: unknown) => String(id))
          : [],
      })),
    });
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/ask-ai/conversations error:', err);
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}

export async function POST() {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;

    // If there's an existing empty "New Chat" with 0 messages and 0 plans created recently, reuse it
    const existingEmpty = await client.query(
      `SELECT c.id, c.summary, c.created_at, c.updated_at
       FROM conversations c
       WHERE c.org_id = $1 AND c.contact_id = $2
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.org_id = c.org_id)
         AND NOT EXISTS (SELECT 1 FROM agent_plans p WHERE p.thread_id = c.id::text AND p.org_id = c.org_id)
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [orgId, contactId]
    );

    if (existingEmpty.rows.length > 0) {
      let askMode = 'auto';
      let askEmployeeIds: string[] = [];
      try {
        const modeRow = await client.query(
          `SELECT ask_mode, ask_employee_ids FROM conversations WHERE id = $1`,
          [existingEmpty.rows[0].id],
        );
        askMode = modeRow.rows[0]?.ask_mode || 'auto';
        askEmployeeIds = Array.isArray(modeRow.rows[0]?.ask_employee_ids)
          ? modeRow.rows[0].ask_employee_ids.map((id: unknown) => String(id))
          : [];
      } catch {
        // migration not applied
      }
      return NextResponse.json({
        success: true,
        conversation: {
          id: existingEmpty.rows[0].id,
          summary: existingEmpty.rows[0].summary || 'New Chat',
          created_at: existingEmpty.rows[0].created_at,
          updated_at: existingEmpty.rows[0].updated_at,
          message_count: 0,
          askMode,
          askEmployeeIds,
        },
      });
    }

    let seedMode = 'auto';
    let seedIds: string[] = [];
    try {
      const prefs = await client.query(
        `SELECT ask_mode, ask_employee_ids FROM ask_ai_user_mode_prefs
          WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
        [orgId, userId],
      );
      if (prefs.rows[0]) {
        seedMode = prefs.rows[0].ask_mode || 'auto';
        seedIds = Array.isArray(prefs.rows[0].ask_employee_ids)
          ? prefs.rows[0].ask_employee_ids.map((id: unknown) => String(id))
          : [];
      }
    } catch {
      // table may not exist yet
    }

    const newId = crypto.randomUUID();
    let created;
    try {
      created = await client.query(
        `INSERT INTO conversations (id, org_id, contact_id, status, summary, metadata, ask_mode, ask_employee_ids, started_at, updated_at)
         VALUES ($1, $2, $3, 'open', 'New Chat', $4::jsonb, $5, $6::uuid[], NOW(), NOW())
         RETURNING id, summary, created_at, updated_at, ask_mode, ask_employee_ids`,
        [newId, orgId, contactId, JSON.stringify({ source: 'ask-ai', userId }), seedMode, seedIds]
      );
    } catch (insertErr: any) {
      if (insertErr?.code !== '42703') throw insertErr;
      created = await client.query(
        `INSERT INTO conversations (id, org_id, contact_id, status, summary, metadata, started_at, updated_at)
         VALUES ($1, $2, $3, 'open', 'New Chat', $4::jsonb, NOW(), NOW())
         RETURNING id, summary, created_at, updated_at`,
        [newId, orgId, contactId, JSON.stringify({ source: 'ask-ai', userId })]
      );
    }

    return NextResponse.json({
      success: true,
      conversation: {
        id: created.rows[0].id,
        summary: created.rows[0].summary || 'New Chat',
        created_at: created.rows[0].created_at,
        updated_at: created.rows[0].updated_at,
        message_count: 0,
        askMode: created.rows[0].ask_mode || seedMode,
        askEmployeeIds: Array.isArray(created.rows[0].ask_employee_ids)
          ? created.rows[0].ask_employee_ids.map((id: unknown) => String(id))
          : seedIds,
      },
    });
  } catch (err: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('POST /api/ask-ai/conversations error:', err);
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}

export async function PATCH(request: Request) {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const body = await jsonBodyOrEmpty(request);
    if (body?.org_id !== undefined || body?.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }
    const { id, summary } = body || {};
    if (!id || !UUID_RE.test(id) || typeof summary !== 'string') {
      return NextResponse.json({ error: 'Valid id and summary are required' }, { status: 400 });
    }

    const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
    const cleanSummary = summary.trim().slice(0, 120);
    const res = await client.query(
      `UPDATE conversations
       SET summary = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
         AND (
           contact_id = $4
           OR (metadata->>'source' = 'ask-ai' AND metadata->>'userId' = $5)
         )
       RETURNING id, summary, updated_at`,
      [cleanSummary, id, orgId, contactId, userId]
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, conversation: res.rows[0] });
  } catch (err: any) {
    const __scopedAuth3 = scopedAuthErrorResponse(err);
    if (__scopedAuth3) return __scopedAuth3;
    console.error('PATCH /api/ask-ai/conversations error:', err);
    return NextResponse.json({ error: 'Failed to update conversation' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}

export async function DELETE(request: Request) {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const { searchParams } = new URL(request.url);
    let targetId = searchParams.get('id');
    if (!targetId) {
      try {
        const body = await jsonBodyOrEmpty(request);
        if (body?.org_id !== undefined || body?.orgId !== undefined) {
          return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
        }
        targetId = body?.id;
      } catch {
        // no body — query param only
      }
    }

    if (!targetId || !UUID_RE.test(targetId)) {
      return NextResponse.json({ error: 'Valid conversation ID is required' }, { status: 400 });
    }

    const contactId = `${ASK_AI_CONTACT_PREFIX}${userId}`;
    const res = await client.query(
      `DELETE FROM conversations
       WHERE id = $1 AND org_id = $2
         AND (
           contact_id = $3
           OR (metadata->>'source' = 'ask-ai' AND metadata->>'userId' = $4)
         )
       RETURNING id`,
      [targetId, orgId, contactId, userId]
    );

    if (res.rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // Clean up plans associated with this conversation thread
    await client.query(
      `DELETE FROM agent_plans WHERE org_id = $1 AND thread_id = $2`,
      [orgId, targetId]
    );

    return NextResponse.json({ success: true, deletedId: res.rows[0].id });
  } catch (err: any) {
    const __scopedAuth4 = scopedAuthErrorResponse(err);
    if (__scopedAuth4) return __scopedAuth4;
    console.error('DELETE /api/ask-ai/conversations error:', err);
    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
