import { NextResponse } from 'next/server';
import { fireInboundAgent } from '@/lib/inbound-agent';
import { assertGmailPushToken } from '@/lib/webhook-crypto';
import { getNangoConnection } from '@/lib/nango-server';
import { parsePortalEmail } from '@/lib/portal-email-parse';
import {
  inboundJobFromPersist,
  persistInboundMessage,
  resolveChannelByMeta,
  resolveSingleOrgChannel,
} from '@/lib/channel-normalize';
import { getOrgScopedClient } from '@/lib/db';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';

type GmailPushNotice = { emailAddress: string | null; historyId: string | null };

function decodePubsubNotice(body: Record<string, unknown>): GmailPushNotice {
  const message = (body.message as Record<string, unknown> | undefined) || {};
  const data = typeof message.data === 'string' ? message.data : '';
  if (!data) {
    return {
      emailAddress: typeof body.emailAddress === 'string' ? body.emailAddress : null,
      historyId: body.historyId != null ? String(body.historyId) : null,
    };
  }
  try {
    const json = Buffer.from(data, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      emailAddress: typeof parsed.emailAddress === 'string' ? parsed.emailAddress : null,
      historyId: parsed.historyId != null ? String(parsed.historyId) : null,
    };
  } catch {
    return { emailAddress: null, historyId: null };
  }
}

function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const found = headers.find((h) => (h.name || '').toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

function decodeGmailPayload(data?: string): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    try {
      return Buffer.from(data, 'base64').toString('utf8');
    } catch {
      return '';
    }
  }
}

function extractGmailBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain') {
    const body = payload.body as { data?: string } | undefined;
    if (body?.data) return decodeGmailPayload(body.data);
  }
  if (payload.mimeType === 'text/html') {
    const body = payload.body as { data?: string } | undefined;
    if (body?.data) {
      return decodeGmailPayload(body.data)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  let best = '';
  for (const part of (payload.parts as Record<string, unknown>[]) || []) {
    const child = extractGmailBody(part);
    if (child.length > best.length) best = child;
  }
  return best;
}

async function gmailAccessToken(orgId: string): Promise<string | null> {
  const conn = await getNangoConnection(orgId, 'gmail');
  const token =
    conn?.credentials?.raw?.access_token || conn?.credentials?.access_token || null;
  return typeof token === 'string' && token ? token : null;
}

type FetchedMail = {
  id: string;
  from: string;
  subject: string;
  body: string;
};

async function fetchRecentMail(accessToken: string, historyId: string | null): Promise<FetchedMail[]> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const ids: string[] = [];
  if (historyId) {
    const histRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}`,
      { headers }
    );
    if (histRes.ok) {
      const hist = (await histRes.json()) as {
        history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
      };
      for (const row of hist.history || []) {
        for (const added of row.messagesAdded || []) {
          const id = added.message?.id;
          if (id) ids.push(id);
        }
      }
    }
  }
  if (ids.length === 0) {
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5', {
      headers,
    });
    if (!listRes.ok) return [];
    const list = (await listRes.json()) as { messages?: Array<{ id?: string }> };
    for (const item of list.messages || []) {
      if (item.id) ids.push(item.id);
    }
  }

  const unique = [...new Set(ids)].slice(0, 8);
  const out: FetchedMail[] = [];
  for (const id of unique) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      { headers }
    );
    if (!msgRes.ok) continue;
    const msg = (await msgRes.json()) as {
      id?: string;
      snippet?: string;
      payload?: Record<string, unknown>;
    };
    const hdrs = ((msg.payload?.headers as Array<{ name?: string; value?: string }>) || []);
    out.push({
      id: msg.id || id,
      from: headerValue(hdrs, 'From'),
      subject: headerValue(hdrs, 'Subject'),
      body: extractGmailBody(msg.payload) || msg.snippet || '',
    });
  }
  return out;
}

async function insertPortalInquiry(
  orgId: string,
  conversationId: string,
  parsed: ReturnType<typeof parsePortalEmail>,
  contactId: string
): Promise<void> {
  if (!parsed.isPortalLead) return;
  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query(
      `INSERT INTO re_inquiries (
         org_id, conversation_id, contact_id, channel, status,
         bhk, locality, city, budget_max, currency, payload
       ) VALUES ($1, $2, $3, 'gmail', 'new', $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        orgId,
        conversationId,
        contactId,
        parsed.bhk,
        parsed.locality,
        parsed.city,
        parsed.budgetMax,
        parsed.currency,
        JSON.stringify({
          portal: parsed.portal,
          listingRef: parsed.listingRef,
          contactName: parsed.contactName,
          contactPhone: parsed.contactPhone,
          contactEmail: parsed.contactEmail,
          summary: parsed.summary,
          source: 'portal-email-parse',
        }),
      ]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[Gmail Webhook] re_inquiries insert skipped:', message);
  } finally {
    client.release();
  }
}

/**
 * POST /api/webhooks/gmail
 * Gmail Pub/Sub push → persist work item + parse portal email already received (never scrape).
 * H1/Gmail reconnect: infra/scripts/OPERATOR_HYGIENE.md §3.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = assertGmailPushToken(req, rawBody);
  if (!sig.ok) {
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  void (body as { org_id?: unknown }).org_id;
  void (body as { orgId?: unknown }).orgId;

  const notice = decodePubsubNotice(body);
  const emailAddress = notice.emailAddress;
  if (!emailAddress) {
    return new NextResponse('OK', { status: 200 });
  }

  const matched =
    (await resolveChannelByMeta('gmail', 'email', emailAddress)) ||
    (await resolveChannelByMeta('gmail', 'emailAddress', emailAddress)) ||
    (await resolveChannelByMeta('gmail', 'email_address', emailAddress)) ||
    (await resolveSingleOrgChannel('gmail'));

  if (!matched?.org_id) {
    console.error('[Gmail Webhook] Cannot resolve org for mailbox', emailAddress);
    return new NextResponse('OK', { status: 200 });
  }

  const webhookLimited = denyWebhookIfLimited(matched.org_id);
  if (webhookLimited) return webhookLimited;

  const agentJobs: Array<Parameters<typeof fireInboundAgent>[0]> = [];

  try {
    const token = await gmailAccessToken(matched.org_id);
    const mails = token ? await fetchRecentMail(token, notice.historyId) : [];

    if (!token || mails.length === 0) {
      const content = token
        ? `[Gmail push] ${emailAddress} history ${notice.historyId || 'unknown'} — no new messages readable.`
        : `[Gmail push] ${emailAddress} — Gmail not connected. Authorize at /connectors.`;
      const persisted = await persistInboundMessage({
        orgId: matched.org_id,
        channelKey: 'gmail',
        channelType: 'gmail',
        contactId: emailAddress,
        content,
        providerMessageId: notice.historyId ? `gmail-hist:${notice.historyId}` : null,
        extraMeta: { emailAddress, historyId: notice.historyId, connected: Boolean(token) },
      });
      if (persisted.shouldFireAgent && token) {
        agentJobs.push(
          inboundJobFromPersist(
            matched.org_id,
            {
              orgId: matched.org_id,
              channelKey: 'gmail',
              channelType: 'gmail',
              contactId: emailAddress,
              content,
              providerMessageId: notice.historyId ? `gmail-hist:${notice.historyId}` : null,
            },
            persisted
          )
        );
      }
    } else {
      for (const mail of mails) {
        const parsed = parsePortalEmail({
          from: mail.from,
          subject: mail.subject,
          body: mail.body,
        });
        const content = parsed.isPortalLead
          ? `[Portal lead: ${parsed.portal}] ${mail.subject}\n${parsed.summary}\n\n${mail.body}`.slice(0, 8000)
          : `${mail.subject}\n\n${mail.body}`.slice(0, 8000);
        const contactId = parsed.contactEmail || parsed.contactPhone || mail.from || emailAddress;
        const persisted = await persistInboundMessage({
          orgId: matched.org_id,
          channelKey: 'gmail',
          channelType: 'gmail',
          contactId,
          content,
          providerMessageId: mail.id,
          senderName: parsed.contactName || mail.from,
          extraMeta: {
            emailAddress,
            email: emailAddress,
            portal: parsed.portal,
            isPortalLead: parsed.isPortalLead,
          },
        });
        if (parsed.isPortalLead && persisted.inserted) {
          await insertPortalInquiry(matched.org_id, persisted.conversationId, parsed, contactId);
        }
        if (persisted.shouldFireAgent) {
          agentJobs.push(
            inboundJobFromPersist(
              matched.org_id,
              {
                orgId: matched.org_id,
                channelKey: 'gmail',
                channelType: 'gmail',
                contactId,
                content,
                providerMessageId: mail.id,
              },
              persisted
            )
          );
        }
      }
    }
  } catch (err: unknown) {
    if (isRateLimitError(err)) return responseFromRateLimit(err);
    const text = err instanceof Error ? err.message : String(err);
    console.error('[Gmail Webhook] Processing error:', text);
  }

  for (const job of agentJobs) {
    fireInboundAgent(job);
  }
  return new NextResponse('OK', { status: 200 });
}
