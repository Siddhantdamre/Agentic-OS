import pdfParse from 'pdf-parse';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = [
  'fetch_latest_emails',
  'triage_emails',
  'extract_otp',
  'extract_attachment',
  'draft_email',
  'send_email',
] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('draft') || a.includes('compose') || a.includes('write_email')) return 'draft';
  if (a.includes('fetch') || a.includes('read') || a.includes('list')) return 'read';
  if (a.includes('triage') || a.includes('classify')) return 'read';
  if (a.includes('otp') || a.includes('verification_code') || a.includes('extract_otp')) return 'read';
  if (a.includes('attachment') || a.includes('parse_attachment') || a.includes('read_attachment')) return 'read';
  return 'send';
}

async function fetchRealGmailMessages(accessToken: string, count: number = 10): Promise<any[]> {
  try {
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) return [];

    const listData = await listRes.json();
    const messageList = listData.messages || [];

    const emailPromises = messageList.map(async (msgItem: any) => {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) return null;
        const msgData = await msgRes.json();

        const headers = msgData.payload?.headers || [];
        const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown Sender';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)';
        const date = headers.find((h: any) => h.name === 'Date')?.value || '';

        return {
          id: msgData.id,
          threadId: msgData.threadId,
          from,
          subject,
          snippet: msgData.snippet || '',
          date,
        };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(emailPromises);
    return results.filter(Boolean);
  } catch (err) {
    console.error('Gmail API Live Fetch Error:', err);
    return [];
  }
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

function extractGmailBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeGmailPayload(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeGmailPayload(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  let body = '';
  for (const part of payload.parts || []) {
    const child = extractGmailBody(part);
    if (child && child.length > body.length) body = child;
  }
  return body;
}

interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

function collectGmailAttachments(payload: any, acc: GmailAttachmentMeta[] = []): GmailAttachmentMeta[] {
  if (!payload) return acc;
  if (payload.filename && payload.body?.attachmentId) {
    acc.push({
      attachmentId: payload.body.attachmentId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: parseInt(payload.body.size || '0', 10),
    });
  }
  for (const part of payload.parts || []) collectGmailAttachments(part, acc);
  return acc;
}

async function fetchGmailMessageFull(accessToken: string, msgId: string): Promise<any | null> {
  try {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) return null;
    const msgData = await msgRes.json();

    const headers = msgData.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown Sender';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)';
    const date = headers.find((h: any) => h.name === 'Date')?.value || '';

    return {
      id: msgData.id,
      threadId: msgData.threadId,
      from,
      subject,
      date,
      snippet: msgData.snippet || '',
      body: extractGmailBody(msgData.payload),
      attachments: collectGmailAttachments(msgData.payload),
      labelIds: msgData.labelIds || [],
    };
  } catch {
    return null;
  }
}

/**
 * AN EMPTY INBOX AND A BROKEN INBOX ARE NOT THE SAME ANSWER.
 *
 * This returned `[]` both when Gmail said there were no messages and when the
 * call failed — an expired token, a 429, Google having a bad morning. Every
 * caller then built a result that said, in full:
 *
 *   status: 'executed'
 *   message: "Fetched 0 real live emails from connected Gmail account"
 *
 * So on an outage the tool reported SUCCESS and zero email, and the agent told
 * the owner their inbox was empty. That is the worst shape a failure can take:
 * confident, wrong, and indistinguishable from the truth. An owner who acts on
 * "you have no new enquiries" loses real business, and nothing anywhere would
 * ever show that Gmail had been down.
 *
 * The failure is now named and carried out. `failure` non-null means we do not
 * know what is in the inbox; an empty `emails` with `failure: null` means we
 * looked and it really was empty.
 */
interface GmailFetch {
  emails: any[];
  /** Non-null when the inbox could not be read. Never set merely because it was empty. */
  failure: string | null;
}

async function fetchRealGmailMessagesFull(accessToken: string, count: number = 10): Promise<GmailFetch> {
  try {
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) {
      // 401/403 is almost always an expired or revoked token, which is
      // actionable by the owner in a way "Gmail error" is not.
      const why = listRes.status === 401 || listRes.status === 403
        ? 'the Gmail connection has expired or been revoked — reconnect it'
        : `Gmail returned HTTP ${listRes.status}`;
      return { emails: [], failure: why };
    }
    const listData = await listRes.json();
    const messageList = listData.messages || [];
    const results = await Promise.all(
      messageList.map(async (m: any) => fetchGmailMessageFull(accessToken, m.id))
    );
    return { emails: results.filter(Boolean), failure: null };
  } catch (err) {
    console.error('Gmail Full Fetch Error:', err);
    return {
      emails: [],
      failure: err instanceof Error ? err.message.slice(0, 120) : 'Gmail could not be reached',
    };
  }
}

/**
 * What the agent is told when the inbox could not be read.
 *
 * Written as an instruction, for the same reason the tool-executor refusals
 * are: a tool result goes into the model's context and gets paraphrased to
 * whoever asked. It must never become "you have no emails".
 */
function gmailUnavailable(action: string, reason: string, timestamp: string) {
  return {
    tool: 'gmail',
    action,
    status: 'error' as const,
    message:
      'The mailbox could not be read, so the number of emails is UNKNOWN — it is not zero. '
      + 'Do NOT tell anyone their inbox is empty or that they have no new mail. Say the '
      + 'mailbox could not be checked just now and that you will confirm shortly.',
    data: { reason, emails: [], inboxUnknown: true },
    timestamp,
  };
}

async function downloadGmailAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer | null> {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data) return null;
    return Buffer.from(data.data, 'base64url');
  } catch {
    return null;
  }
}

function classifyEmail(email: any): string {
  const subject = (email.subject || '').toLowerCase();
  const from = (email.from || '').toLowerCase();
  const body = (email.body || '').toLowerCase();
  const text = `${subject} ${from} ${body}`.slice(0, 2000);

  if (/\b(urgent|asap|immediately|critical|account suspended|payment failed|data breach|security alert)\b/.test(text)) return 'urgent';
  if (/\b(invoice|payment received|receipt|order confirmation|billing|refund|subscription)\b/.test(text)) return 'billing';
  if (/\b(otp|verification code|login code|security code|sign in|password reset|2fa|authenticator)\b/.test(text)) return 'security';
  if (/\b(issue|problem|help|support|question|complaint|bug)\b/.test(text)) return 'customer-support';
  if (/\b(newsletter|promo|sale|discount|offer|unsubscribe|weekly digest|announcement)\b/.test(text)) return 'newsletter';
  if (/no[- ]?reply@|noreply@|donotreply@|no.reply@/.test(from)) return 'automated';
  return 'general';
}

function extractOtpsFromText(text: string): Array<{ code: string; context: string }> {
  const results: Array<{ code: string; context: string }> = [];
  if (!text) return results;
  const keywordRe = /otp|one[\s-]?time|verification|security code|login code|access code|2fa|passcode|sign.?in|valid for|expires|code is/i;
  const codeRe = /(?<!\d)(\d{4,8})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(text)) !== null) {
    const code = m[1];
    if (!/^[0-9]{4,8}$/.test(code)) continue;
    const start = Math.max(0, m.index - 90);
    const window = text.slice(start, Math.min(text.length, m.index + m[0].length + 90));
    if (keywordRe.test(window)) {
      results.push({ code, context: window.replace(/\s+/g, ' ').trim() });
      if (results.length >= 20) break;
    }
  }
  return results;
}

void fetchRealGmailMessages;

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gmailConnId = `${orgId}_gmail`;
  let gmailToken: string | null = null;
  for (const providerKey of ['gmail', 'google-mail', 'google']) {
    gmailToken = await getNangoAccessToken(gmailConnId, providerKey);
    if (gmailToken) break;
  }
  const accessToken = gmailToken;

  if (actionName.includes('fetch') || actionName.includes('read') || actionName.includes('list')) {
    const count = payload.count || 10;

    if (accessToken) {
      console.log(`[Gmail Tool] Fetching real live emails using OAuth access token for connection ${gmailConnId}...`);
      const fetched = await fetchRealGmailMessagesFull(accessToken, count);
      if (fetched.failure) return gmailUnavailable('fetch_latest_emails', fetched.failure, timestamp);
      const realEmails = fetched.emails;

      return {
        tool: 'gmail',
        action: 'fetch_latest_emails',
        status: 'executed' as const,
        message: `Fetched ${realEmails.length} real live emails from connected Gmail account`,
        data: {
          totalFetched: realEmails.length,
          filter: payload.filter || 'inbox',
          emails: realEmails,
        },
        timestamp,
      };
    }

    return notConnected('gmail', 'fetch_latest_emails', timestamp);
  }

  if (actionName.includes('triage') || actionName.includes('classify')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Triaging inbox...');
      const triaged = await fetchRealGmailMessagesFull(accessToken, count);
      if (triaged.failure) return gmailUnavailable('triage_emails', triaged.failure, timestamp);
      const emails = triaged.emails;
      const categorized = emails.map((e) => ({ ...e, category: classifyEmail(e) }));
      const summary: Record<string, number> = {};
      for (const em of categorized) summary[em.category] = (summary[em.category] || 0) + 1;
      return {
        tool: 'gmail',
        action: 'triage_emails',
        status: 'executed' as const,
        message: `Triaged ${emails.length} emails into ${Object.keys(summary).length} categories`,
        data: {
          totalTriaged: emails.length,
          summary,
          emails: categorized.map((em) => ({
            id: em.id,
            from: em.from,
            subject: em.subject,
            date: em.date,
            category: em.category,
            bodyPreview: (em.body || '').slice(0, 200),
          })),
        },
        timestamp,
      };
    }
    return notConnected('gmail', 'triage_emails', timestamp);
  }

  if (actionName.includes('otp') || actionName.includes('verification_code') || actionName.includes('extract_otp')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Scanning mail for OTP / verification codes...');
      const otpFetch = await fetchRealGmailMessagesFull(accessToken, count);
      if (otpFetch.failure) return gmailUnavailable('extract_otp', otpFetch.failure, timestamp);
      const emails = otpFetch.emails;
      const found: Array<{ code: string; context: string; from: string; subject: string; date: string; messageId: string }> = [];
      for (const em of emails) {
        for (const hit of extractOtpsFromText(`${em.body}\n${em.subject}`)) {
          found.push({ ...hit, from: em.from, subject: em.subject, date: em.date, messageId: em.id });
        }
      }
      return {
        tool: 'gmail',
        action: 'extract_otp',
        status: 'executed' as const,
        message: found.length
          ? `Found ${found.length} verification code${found.length > 1 ? 's' : ''} in the latest ${emails.length} emails`
          : `No verification codes found in the latest ${emails.length} emails`,
        data: { scannedEmails: emails.length, codes: found },
        timestamp,
      };
    }
    return notConnected('gmail', 'extract_otp', timestamp);
  }

  if (actionName.includes('attachment') || actionName.includes('parse_attachment') || actionName.includes('read_attachment')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Locating and parsing attachments...');
      const attFetch = await fetchRealGmailMessagesFull(accessToken, count);
      if (attFetch.failure) return gmailUnavailable('find_attachment', attFetch.failure, timestamp);
      const emails = attFetch.emails;
      const targetSubject = (payload.subject || '').toLowerCase();
      const targetFilename = (payload.filename || '').toLowerCase();

      const candidates = emails.filter(
        (e) =>
          e.attachments.length > 0 &&
          (!targetSubject || (e.subject || '').toLowerCase().includes(targetSubject)) &&
          (!targetFilename || e.attachments.some((a: any) => a.filename.toLowerCase().includes(targetFilename)))
      );

      if (candidates.length === 0) {
        return {
          tool: 'gmail',
          action: 'extract_attachment',
          status: 'error' as const,
          message: `No email with attachments found in the latest ${emails.length} emails${targetSubject ? ` matching subject "${targetSubject}"` : ''}`,
          data: { scannedEmails: emails.length },
          timestamp,
        };
      }

      const em = candidates[0];
      const att = em.attachments[0];
      const buffer = await downloadGmailAttachment(accessToken, em.id, att.attachmentId);
      if (!buffer) {
        return {
          tool: 'gmail', action: 'extract_attachment', status: 'error' as const,
          message: `Failed to download attachment "${att.filename}"`, data: null, timestamp,
        };
      }

      let content = '';
      let parseType = 'unsupported';
      const isPdf = att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf');
      const isText = att.mimeType.startsWith('text/') || /\.(txt|csv|md|json|log)$/i.test(att.filename);
      if (isPdf) {
        try {
          const parsed = await pdfParse(buffer);
          content = (parsed && parsed.text) || '';
          parseType = 'pdf';
        } catch (e: any) {
          console.error('[Gmail Tool] PDF parse error:', e.message);
          content = `(PDF text extraction failed: ${e.message})`;
        }
      } else if (isText) {
        content = buffer.toString('utf8');
        parseType = 'text';
      } else {
        content = `Downloaded ${att.filename} (${att.mimeType}, ${buffer.length} bytes). Binary format — parsed inline on request.`;
      }

      return {
        tool: 'gmail',
        action: 'extract_attachment',
        status: 'executed' as const,
        message: `Parsed attachment "${att.filename}" from "${em.subject}" (${parseType})`,
        data: {
          sourceEmail: { id: em.id, from: em.from, subject: em.subject },
          fileName: att.filename,
          mimeType: att.mimeType,
          sizeBytes: buffer.length,
          parseType,
          contentPreview: content.slice(0, 6000),
          totalCharacters: content.length,
        },
        timestamp,
      };
    }
    return notConnected('gmail', 'extract_attachment', timestamp);
  }

  if (actionName.includes('draft') || actionName.includes('compose') || actionName.includes('write_email')) {
    const toEmail = payload.to || payload.recipient;
    const subject = payload.subject;
    const bodyText = payload.body || payload.content || '';

    if (!toEmail) return { tool: 'gmail', action: 'draft_email', status: 'error' as const, message: 'Recipient email (to/recipient) is required.', data: null, timestamp };
    if (!subject) return { tool: 'gmail', action: 'draft_email', status: 'error' as const, message: 'Email subject is required.', data: null, timestamp };

    if (!accessToken) return notConnected('gmail', 'draft_email', timestamp);

    try {
      const rawEmail = [
        `To: ${toEmail}`,
        `Subject: ${subject}`,
        ...(payload.cc ? [`Cc: ${payload.cc}`] : []),
        ...(payload.bcc ? [`Bcc: ${payload.bcc}`] : []),
        'Content-Type: text/plain; charset=utf-8',
        '',
        bodyText,
      ].join('\r\n');

      const base64EncodedEmail = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw: base64EncodedEmail } }),
      });

      if (draftRes.ok) {
        const draftData = await draftRes.json();
        return {
          tool: 'gmail',
          action: 'draft_email',
          status: 'executed' as const,
          message: `Draft saved to Gmail for ${toEmail} — nothing has been sent yet`,
          data: {
            draftId: draftData.id,
            messageId: draftData.message?.id,
            recipient: toEmail,
            subject,
          },
          timestamp,
        };
      }
      return {
        tool: 'gmail',
        action: 'draft_email',
        status: 'error' as const,
        message: `Gmail draft failed: HTTP ${draftRes.status} ${await draftRes.text().catch(() => '')}`,
        data: null,
        timestamp,
      };
    } catch (e: any) {
      console.error('[Gmail Tool] Draft error:', e);
      return { tool: 'gmail', action: 'draft_email', status: 'error' as const, message: `Gmail draft error: ${e.message}`, data: null, timestamp };
    }
  }

  const toEmail = payload.to || payload.recipient;
  const subject = payload.subject;
  const bodyText = payload.body || payload.content || '';

  if (!toEmail) {
    return {
      tool: 'gmail',
      action: 'send_email',
      status: 'error' as const,
      message: 'Recipient email parameter (to/recipient) is required.',
      data: null,
      timestamp,
    };
  }
  if (!subject) {
    return {
      tool: 'gmail',
      action: 'send_email',
      status: 'error' as const,
      message: 'Email subject parameter is required.',
      data: null,
      timestamp,
    };
  }

  if (accessToken) {
    try {
      const rawEmail = [
        `To: ${toEmail}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        bodyText,
      ].join('\r\n');

      const base64EncodedEmail = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: base64EncodedEmail }),
      });

      if (sendRes.ok) {
        const sendData = await sendRes.json();
        return {
          tool: 'gmail',
          action: 'send_email',
          status: 'executed' as const,
          message: `Dispatched real email to ${toEmail} via Gmail API`,
          data: {
            messageId: sendData.id,
            threadId: sendData.threadId,
            recipient: toEmail,
            subject,
          },
          timestamp,
        };
      }

      return {
        tool: 'gmail',
        action: 'send_email',
        status: 'error' as const,
        message: `Gmail send failed: HTTP ${sendRes.status} ${await sendRes.text().catch(() => '')}`,
        data: null,
        timestamp,
      };
    } catch (e: any) {
      console.error('Gmail real send error:', e);
      return {
        tool: 'gmail',
        action: 'send_email',
        status: 'error' as const,
        message: `Gmail send error: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  return notConnected('gmail', 'send_email', timestamp);
}

export const gmail: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
