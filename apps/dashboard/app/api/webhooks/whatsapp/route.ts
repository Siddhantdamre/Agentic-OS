import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { runAutonomousAgentLoop } from '@darex/workflows/dist/agent-engine';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';

/**
 * GET /api/webhooks/whatsapp
 * Meta webhook verification challenge handler.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new NextResponse('Forbidden', { status: 403 });
  } catch (error) {
    console.error('[WhatsApp Webhook] GET error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

/**
 * POST /api/webhooks/whatsapp
 * Handles real inbound WhatsApp messages from Meta Cloud API.
 * Always returns 200 to prevent Meta retry storms.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  if (body.object !== 'whatsapp_business_account') {
    return new NextResponse('OK', { status: 200 });
  }

  const entries = body.entry || [];

  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = value.messages || [];

      for (const message of messages) {
        const from: string = message.from; // sender phone number
        const text: string = message.text?.body || '';
        const messageId: string = message.id;
        const ts: string = message.timestamp;

        if (!text || !from) continue;

        const client = await pool.connect();
        try {
          // ── 1. Resolve the correct org ────────────────────────────────────
          // Match org via the inbound phone number ID from Meta payload (multi-tenant safe)
          let orgId: string | null = null;
          let channelId: string | null = null;
          let orgPhoneNumberId: string | null = null;
          let orgMetaToken: string | null = null;

          const inboundPhoneNumberId = value.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

          // a) Match channel by phone_number_id stored in channel meta.
          // Order by most recently connected so the newest matching channel wins
          // when multiple orgs share the same number.
          if (inboundPhoneNumberId) {
            const chanByPhone = await client.query(
              `SELECT id, org_id, meta FROM channels WHERE channel_type = 'whatsapp' AND meta->>'phone_number_id' = $1 ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
              [inboundPhoneNumberId]
            );
            if (chanByPhone.rows.length > 0) {
              channelId = chanByPhone.rows[0].id;
              orgId = chanByPhone.rows[0].org_id;
              const chanMeta = chanByPhone.rows[0].meta || {};
              orgPhoneNumberId = chanMeta.phone_number_id || inboundPhoneNumberId;
              orgMetaToken = chanMeta.meta_access_token || process.env.META_ACCESS_TOKEN || null;
            }
          }

          // b) Match channel by WABA ID
          if (!orgId) {
            const wabId = value.metadata?.display_phone_number || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
            const chanByMeta = await client.query(
              `SELECT id, org_id, meta FROM channels WHERE channel_type = 'whatsapp' AND meta->>'whatsapp_business_account_id' = $1 ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
              [wabId]
            );
            if (chanByMeta.rows.length > 0) {
              channelId = chanByMeta.rows[0].id;
              orgId = chanByMeta.rows[0].org_id;
              const chanMeta = chanByMeta.rows[0].meta || {};
              orgPhoneNumberId = chanMeta.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || null;
              orgMetaToken = chanMeta.meta_access_token || process.env.META_ACCESS_TOKEN || null;
            }
          }

          // c) Any active WhatsApp channel (single-tenant dev fallback)
          if (!orgId) {
            const orgCount = await client.query(`SELECT COUNT(*) as count FROM orgs WHERE status = 'active'`);
            if (parseInt(orgCount.rows[0].count, 10) === 1) {
              const chanAny = await client.query(
                `SELECT id, org_id, meta FROM channels WHERE channel_type = 'whatsapp' AND status = 'active' LIMIT 1`
              );
              if (chanAny.rows.length > 0) {
                channelId = chanAny.rows[0].id;
                orgId = chanAny.rows[0].org_id;
                const chanMeta = chanAny.rows[0].meta || {};
                orgPhoneNumberId = chanMeta.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || null;
                orgMetaToken = chanMeta.meta_access_token || process.env.META_ACCESS_TOKEN || null;
              }
            }
          }

          if (!orgId) {
            console.error('[WhatsApp Webhook] Cannot resolve org — skipping message from', from);
            continue;
          }

          // ── 2. Set RLS context ─────────────────────────────────────────────
          await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

          // ── 3. Get or create channel row ──────────────────────────────────
          if (!channelId) {
            const wabId = value.metadata?.display_phone_number || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
            const newChan = await client.query(
              `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
               VALUES ($1, 'whatsapp', 'active', $2, NOW()) RETURNING id`,
              [orgId, JSON.stringify({
                whatsapp_business_account_id: wabId,
                phone_number_id: orgPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
              })]
            );
            channelId = newChan.rows[0].id;
          }

          // ── 4. Get default active AI employee for this org ────────────────
          const empRes = await client.query(
            `SELECT id, name, role, persona, tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`,
            [orgId]
          );
          const employee = empRes.rows[0];

          // ── 5. Upsert conversation ─────────────────────────────────────────
          let conversationId: string;
          const existingConv = await client.query(
            `SELECT id FROM conversations WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved' LIMIT 1`,
            [orgId, from]
          );

          if (existingConv.rows.length > 0) {
            conversationId = existingConv.rows[0].id;
            await client.query(
              `UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND org_id = $2`,
              [conversationId, orgId]
            );
          } else {
            const newConv = await client.query(
              `INSERT INTO conversations (org_id, channel_id, contact_id, employee_id, status, summary, started_at, updated_at)
               VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW())
               RETURNING id`,
              [orgId, channelId, from, employee?.id ?? null, text.slice(0, 100)]
            );
            conversationId = newConv.rows[0].id;
          }

          // ── 6. Insert inbound message ─────────────────────────────────────
          await client.query(
            `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, created_at)
             VALUES ($1, $2, 'user', $3, $4, NOW())`,
            [orgId, conversationId, text, messageId]
          );

          // ── 7. Log inbound to channel_logs ────────────────────────────────
          await client.query(
            `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
             VALUES ($1, 'whatsapp', 'inbound_message', 'success', 200, $2, $3)`,
            [orgId, `Inbound WhatsApp from ${from}`, JSON.stringify({ from, messageId, text })]
          );

          // ── 8. Run AI response via Temporal (durable) or direct fallback ──
          let aiReply = `Hello! I received your message and will get back to you shortly.`;
          let savedByWorkflow = false;
          try {
            const toolAllowlist = (() => {
              if (!employee?.tool_allowlist) return ['whatsapp', 'gmail'];
              if (Array.isArray(employee.tool_allowlist)) return employee.tool_allowlist;
              try { return JSON.parse(employee.tool_allowlist); } catch { return ['whatsapp', 'gmail']; }
            })();

            const agentInput = {
              orgId,
              conversationId,
              channelId: channelId ?? undefined,
              employeeName: employee?.name ?? 'AI Assistant',
              employeeRole: employee?.role ?? 'Support',
              employeePersona: employee?.persona ?? 'Helpful customer support assistant.',
              toolAllowlist,
              userMessage: text,
            };

          // Try Temporal first for durable retryable execution
          let agentResult: any = null;
          try {
            const { triggerAutonomousAgentWorkflow } = await import('@darex/workflows/dist/workflow-client');
            agentResult = await triggerAutonomousAgentWorkflow(agentInput);
            // Only treat the message as already-persisted if the workflow
            // actually ran and returned a result (it calls saveMessageActivity).
            savedByWorkflow = !!agentResult;
            if (agentResult) {
              console.log('[WhatsApp Webhook] Agent ran via Temporal workflow');
            }
          } catch (temporalErr: any) {
            console.warn('[WhatsApp Webhook] Temporal fallback:', temporalErr.message);
          }

          // Fallback: direct in-process
          if (!agentResult) {
            agentResult = await runAutonomousAgentLoop(
              agentInput,
              async (tool, action, payload) => {
                const result = await executeAutonomousToolAction({ tool, action, payload, orgId: orgId! });
                return { status: result.status, data: result.data };
              }
            );
          }

            aiReply = agentResult.replyMessage;
          } catch (agentErr: any) {
            console.error('[WhatsApp Webhook] Agent loop error:', agentErr.message);
          }

          // ── 9. Save AI reply to DB ────────────────────────────────────────
          // The Temporal workflow already persists the assistant reply via
          // saveMessageActivity when it ran. Only insert here for the direct
          // in-process fallback path to avoid duplicate assistant messages.
          if (!savedByWorkflow) {
            await client.query(
              `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
               VALUES ($1, $2, 'assistant', $3, NOW())`,
              [orgId, conversationId, aiReply]
            );
          }

          // ── 10. Send AI reply back via per-org Meta credentials ──────────
          if (orgPhoneNumberId && orgMetaToken) {
            const sendRes = await fetch(
              `https://graph.facebook.com/v18.0/${orgPhoneNumberId}/messages`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${orgMetaToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to: from,
                  type: 'text',
                  text: { body: aiReply },
                }),
              }
            );

            const sendStatus = sendRes.ok ? 'success' : 'error';
            const sendBody = await sendRes.text().catch(() => '');
            if (!sendRes.ok) {
              console.error('[WhatsApp Webhook] Meta send error:', sendBody);
            }

            await client.query(
              `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
               VALUES ($1, 'whatsapp', 'outbound_message', $2, $3, $4, $5)`,
              [
                orgId,
                sendStatus,
                sendRes.status,
                `AI reply to ${from}: ${aiReply.slice(0, 80)}`,
                JSON.stringify({ to: from, status: sendRes.status, body: sendBody.slice(0, 300) }),
              ]
            );
          } else {
            console.warn('[WhatsApp Webhook] No per-org Meta credentials found — AI reply not sent. Store phone_number_id and meta_access_token in channels.meta for this org.');
          }

          // Update conversation updated_at
          await client.query(
            `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
            [text.slice(0, 100), conversationId, orgId]
          );

        } catch (dbErr: any) {
          console.error('[WhatsApp Webhook] Processing error:', dbErr.message);
        } finally {
          client.release();
        }
      }
    }
  }

  // Always return 200 to Meta
  return new NextResponse('OK', { status: 200 });
}
