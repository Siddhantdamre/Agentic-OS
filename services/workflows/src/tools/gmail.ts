import pdfParse from 'pdf-parse';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = [
  'fetch_latest_emails',
  'triage_emails',
  'extract_otp',
  'extract_attachment',
  'read_email',
  'draft_email',
  'draft_reply',
  'send_email',
  'reply_email',
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
    const listRes = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) throw new GmailHttpError(listRes.status);

    const listData = await listRes.json();
    const messageList = listData.messages || [];

    const emailPromises = messageList.map(async (msgItem: any) => {
      try {
        const msgRes = await fetchWithTimeout(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgItem.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!msgRes.ok) {
          if (msgRes.status === 401 || msgRes.status === 403) throw new GmailHttpError(msgRes.status);
          return null;
        }
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
      } catch (err) {
        if (err instanceof GmailHttpError) throw err;
        return null;
      }
    });

    const results = await Promise.all(emailPromises);
    return results.filter(Boolean);
  } catch (err) {
    if (err instanceof GmailHttpError) throw err;
    console.error('Gmail API Live Fetch Error:', err);
    throw err;
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
    const msgRes = await fetchWithTimeout(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!msgRes.ok) {
      if (msgRes.status === 401 || msgRes.status === 403) throw new GmailHttpError(msgRes.status);
      return null;
    }
    const msgData = await msgRes.json();

    const headers = msgData.payload?.headers || [];
    const from = headers.find((h: any) => h.name === 'From')?.value || 'Unknown Sender';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value || '(No Subject)';
    const date = headers.find((h: any) => h.name === 'Date')?.value || '';
    const header = (name: string) =>
      headers.find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value || '';

    return {
      id: msgData.id,
      threadId: msgData.threadId,
      from,
      to: header('To'),
      cc: header('Cc'),
      replyTo: header('Reply-To'),
      messageIdHeader: header('Message-ID'),
      references: header('References'),
      subject,
      date,
      snippet: msgData.snippet || '',
      body: extractGmailBody(msgData.payload),
      attachments: collectGmailAttachments(msgData.payload),
      labelIds: msgData.labelIds || [],
    };
  } catch (err) {
    if (err instanceof GmailHttpError) throw err;
    return null;
  }
}

export class GmailHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gmail HTTP ${status}`);
    this.name = 'GmailHttpError';
  }
}

/** 401/403 are a revoked connector. Any other non-2xx is an API error, never an empty inbox. */
export function gmailHttpFailure(action: string, timestamp: string, status: number) {
  const revoked = status === 401 || status === 403;
  return apiError(
    'gmail',
    action,
    timestamp,
    revoked ? 'Gmail connection was rejected (revoked or forbidden).' : `Gmail request failed (HTTP ${status}).`,
    { reason: revoked ? 'revoked' : 'api_error', status, connected: !revoked },
  );
}

const GMAIL_MAX_RESULTS = 50;
const GMAIL_QUERY_MAX_CHARS = 500;

/**
 * Message list URL. `query` is Gmail search syntax (`from:alice is:unread
 * newer_than:7d`), so the agent can find a specific email instead of reading
 * the latest N (TOOL-G01). Count is clamped to 1..50.
 */
export function gmailListUrl(count: unknown, query?: unknown): string {
  const n = Math.min(GMAIL_MAX_RESULTS, Math.max(1, Math.trunc(Number(count)) || 10));
  const params = new URLSearchParams({ maxResults: String(n) });
  const q = typeof query === 'string' ? query.trim().slice(0, GMAIL_QUERY_MAX_CHARS) : '';
  if (q) params.set('q', q);
  return `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`;
}

async function fetchRealGmailMessagesFull(accessToken: string, count: number = 10, query?: string): Promise<any[]> {
  try {
    const listRes = await fetchWithTimeout(gmailListUrl(count, query), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) throw new GmailHttpError(listRes.status);
    const listData = await listRes.json();
    const messageList = listData.messages || [];
    const results = await Promise.all(
      messageList.map(async (m: any) => fetchGmailMessageFull(accessToken, m.id))
    );
    return results.filter(Boolean);
  } catch (err) {
    if (err instanceof GmailHttpError) throw err;
    console.error('Gmail Full Fetch Error:', err);
    throw err;
  }
}

async function downloadGmailAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Buffer | null> {
  try {
    const res = await fetchWithTimeout(
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

const TITLE_KEYWORDS =
  /\b(CEO|CTO|CFO|COO|VP|Vice President|President|Founder|Co-Founder|Director|Manager|Head of [A-Za-z& ]+|Engineer|Lead|Officer|Consultant|Analyst|Specialist|Coordinator|Executive)\b/;

/**
 * OE-07: pull a phone number and job title out of an email's signature
 * block (the last few non-empty lines of the body) so a contact's CRM
 * record can be backfilled without asking anyone to type it in. Returns
 * only what it can find with reasonable confidence — never guesses.
 */
export function extractSignatureFields(bodyText: string): { phone?: string; title?: string } {
  if (!bodyText) return {};
  const lines = bodyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // The signature block is conventionally the tail of the message — scan the
  // last ~8 non-empty lines rather than the whole thread/quoted history.
  const tail = lines.slice(-8);

  let phone: string | undefined;
  for (const line of tail) {
    const labeled = line.match(/(?:phone|mobile|cell|tel|m|t)[:\s.]+([+(]?\d[\d\s\-().]{6,}\d)/i);
    if (labeled) {
      phone = labeled[1].trim();
      break;
    }
    const bare = line.match(/(\+?\d[\d\s\-().]{8,}\d)/);
    if (bare) {
      phone = bare[1].trim();
      break;
    }
  }

  let title: string | undefined;
  for (const line of tail) {
    if (TITLE_KEYWORDS.test(line) && line.length <= 80) {
      title = line.replace(/^[-•|]\s*/, '').trim();
      break;
    }
  }

  return { phone, title };
}

/** Header values come from the model; a CR/LF would let it inject headers. */
function headerValue(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim() : '';
}

/** RFC 2047 encode a non-ASCII subject so Gmail shows it intact. */
function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

export interface RawEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: unknown;
  bcc?: unknown;
  inReplyTo?: string;
  references?: string;
}

/** base64url RFC 2822 message for Gmail `messages.send` / `drafts.create`. */
export function buildRawEmail(input: RawEmailInput): string {
  const cc = headerValue(input.cc);
  const bcc = headerValue(input.bcc);
  const inReplyTo = headerValue(input.inReplyTo);
  const references = headerValue(input.references);
  const raw = [
    `To: ${headerValue(input.to)}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${encodeSubject(headerValue(input.subject))}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.body || '', 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

/** "Re: " once, never "Re: Re: ". */
export function replySubject(subject: string): string {
  const s = (subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s || '(No Subject)'}`;
}

function messageIdFrom(payload: Record<string, any>): string {
  const v = payload.messageId ?? payload.message_id ?? payload.id;
  return typeof v === 'string' ? v.trim() : '';
}

/** Gmail ids are hex; anything else never reaches the URL path. */
function isGmailId(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(id);
}

/** Bare addresses from a header like `"Lee, Jo" <jo@a.co>, b@c.co`. */
export function parseAddressList(header: string): string[] {
  const out: string[] = [];
  for (const m of String(header || '').matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s,<>"]+@[^\s,<>"]+)/g)) {
    out.push((m[1] || m[2]).toLowerCase());
  }
  return out;
}

/**
 * Reply-all recipients: the primary goes to the sender (Reply-To or From),
 * everyone else on To/Cc goes to Cc. The account's own address and
 * duplicates are dropped.
 */
export function replyAllRecipients(
  original: { from: string; replyTo?: string; to?: string; cc?: string },
  self: string,
): { to: string; cc: string } {
  const me = self.toLowerCase();
  const primary = parseAddressList(original.replyTo || original.from).filter((a) => a !== me);
  const others = [...parseAddressList(original.to || ''), ...parseAddressList(original.cc || '')];
  const seen = new Set(primary);
  const cc: string[] = [];
  for (const a of others) {
    if (a === me || seen.has(a)) continue;
    seen.add(a);
    cc.push(a);
  }
  // Replying to your own sent mail: the first other recipient becomes primary.
  const to = primary.length ? primary : cc.splice(0, 1);
  return { to: to.join(', '), cc: cc.join(', ') };
}

async function gmailSelfAddress(accessToken: string): Promise<string> {
  const res = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GmailHttpError(res.status);
  const data = await res.json();
  return String(data.emailAddress || '');
}

const READ_BODY_MAX_CHARS = 20000;

void fetchRealGmailMessages;

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const _gmailAuth = await resolveGoogleAuth(orgId, 'gmail');
  const gmailToken: string | null = _gmailAuth.kind === 'connected' ? _gmailAuth.accessToken : null;
  const _gmailAuthErr = _gmailAuth.kind === 'connected' ? null : nangoAuthError('gmail', actionName, timestamp, _gmailAuth);
  const accessToken = gmailToken;

  if (actionName === 'read_email') {
    const id = messageIdFrom(payload);
    if (!isGmailId(id)) {
      return { tool: 'gmail', action: 'read_email', status: 'error' as const, message: 'A Gmail messageId is required. Find it with gmail_fetch first.', data: null, timestamp };
    }
    if (!accessToken) return _gmailAuthErr ?? notConnected('gmail', 'read_email', timestamp);
    try {
      const msg = await fetchGmailMessageFull(accessToken, id);
      if (!msg) return apiError('gmail', 'read_email', timestamp, `No email found with id ${id}.`, { reason: 'not_found' });
      const body = String(msg.body || '');
      return {
        tool: 'gmail',
        action: 'read_email',
        status: 'executed' as const,
        message: `Read "${msg.subject}" from ${msg.from}`,
        data: {
          ...msg,
          body: body.slice(0, READ_BODY_MAX_CHARS),
          bodyTruncated: body.length > READ_BODY_MAX_CHARS,
        },
        timestamp,
      };
    } catch (err) {
      if (err instanceof GmailHttpError) return gmailHttpFailure('read_email', timestamp, err.status);
      return apiError('gmail', 'read_email', timestamp, 'Gmail request failed.', { reason: 'api_error' });
    }
  }

  if (actionName === 'reply_email' || actionName === 'draft_reply') {
    const isDraft = actionName === 'draft_reply';
    const id = messageIdFrom(payload);
    const bodyText = String(payload.body || payload.content || '');
    if (!isGmailId(id)) {
      return { tool: 'gmail', action: actionName, status: 'error' as const, message: 'The messageId of the email being replied to is required. Find it with gmail_fetch first.', data: null, timestamp };
    }
    if (!bodyText.trim()) {
      return { tool: 'gmail', action: actionName, status: 'error' as const, message: 'Reply body is required.', data: null, timestamp };
    }
    if (!accessToken) return _gmailAuthErr ?? notConnected('gmail', actionName, timestamp);
    try {
      const original = await fetchGmailMessageFull(accessToken, id);
      if (!original) return apiError('gmail', actionName, timestamp, `No email found with id ${id}.`, { reason: 'not_found' });
      const replyAll = payload.reply_all === true || payload.replyAll === true;
      let to = headerValue(payload.to) || original.replyTo || original.from;
      let cc = headerValue(payload.cc);
      if (replyAll) {
        const all = replyAllRecipients(original, await gmailSelfAddress(accessToken));
        if (!headerValue(payload.to)) to = all.to || to;
        cc = [all.cc, cc].filter(Boolean).join(', ');
      }
      const subject = replySubject(original.subject);
      const references = [original.references, original.messageIdHeader].filter(Boolean).join(' ');
      const raw = buildRawEmail({
        to,
        subject,
        body: bodyText,
        cc,
        bcc: payload.bcc,
        inReplyTo: original.messageIdHeader,
        references,
      });
      const message = { raw, threadId: original.threadId };
      const res = await fetchWithTimeout(
        `https://gmail.googleapis.com/gmail/v1/users/me/${isDraft ? 'drafts' : 'messages/send'}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(isDraft ? { message } : message),
        },
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return gmailHttpFailure(actionName, timestamp, res.status);
        return apiError('gmail', actionName, timestamp, `Gmail ${isDraft ? 'draft' : 'reply'} failed (HTTP ${res.status}).`, { reason: 'api_error', status: res.status });
      }
      const out = await res.json();
      return {
        tool: 'gmail',
        action: actionName,
        status: 'executed' as const,
        message: isDraft
          ? `Reply draft saved in the "${original.subject}" thread for ${to} — nothing has been sent yet`
          : `Replied to ${to}${cc ? ` (cc ${cc})` : ''} in the "${original.subject}" thread`,
        data: {
          ...(isDraft ? { draftId: out.id, messageId: out.message?.id } : { messageId: out.id }),
          threadId: original.threadId,
          inReplyTo: id,
          recipient: to,
          cc: cc || null,
          replyAll,
          subject,
        },
        timestamp,
      };
    } catch (err) {
      if (err instanceof GmailHttpError) return gmailHttpFailure(actionName, timestamp, err.status);
      return apiError('gmail', actionName, timestamp, `Gmail ${isDraft ? 'draft' : 'reply'} failed.`, { reason: 'api_error' });
    }
  }

  if (actionName.includes('fetch') || actionName.includes('read') || actionName.includes('list')) {
    const count = payload.count || 10;
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';

    if (accessToken) {
      console.log(`[Gmail Tool] Fetching real live emails using OAuth access token for org ${orgId}...`);
      try {
      const realEmails = await fetchRealGmailMessagesFull(accessToken, count, query || undefined);

      return {
        tool: 'gmail',
        action: 'fetch_latest_emails',
        status: 'executed' as const,
        message: query
          ? `Found ${realEmails.length} emails matching "${query}" in the connected Gmail account`
          : `Fetched ${realEmails.length} real live emails from connected Gmail account`,
        data: {
          totalFetched: realEmails.length,
          filter: payload.filter || 'inbox',
          query: query || null,
          emails: realEmails,
        },
        timestamp,
      };
      } catch (err) {
        if (err instanceof GmailHttpError) return gmailHttpFailure('fetch_latest_emails', timestamp, err.status);
        return apiError('gmail', 'fetch_latest_emails', timestamp, 'Gmail request failed.', { reason: 'api_error' });
      }
    }

    return _gmailAuthErr ?? notConnected('gmail', 'fetch_latest_emails', timestamp);
  }

  if (actionName.includes('triage') || actionName.includes('classify')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Triaging inbox...');
      let emails;
      try {
        emails = await fetchRealGmailMessagesFull(accessToken, count);
      } catch (err) {
        if (err instanceof GmailHttpError) return gmailHttpFailure('triage_emails', timestamp, err.status);
        return apiError('gmail', 'triage_emails', timestamp, 'Gmail request failed.', { reason: 'api_error' });
      }
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
    return _gmailAuthErr ?? notConnected('gmail', 'triage_emails', timestamp);
  }

  if (actionName.includes('otp') || actionName.includes('verification_code') || actionName.includes('extract_otp')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Scanning mail for OTP / verification codes...');
      let emails;
      try {
        emails = await fetchRealGmailMessagesFull(accessToken, count);
      } catch (err) {
        if (err instanceof GmailHttpError) return gmailHttpFailure('extract_otp', timestamp, err.status);
        return apiError('gmail', 'extract_otp', timestamp, 'Gmail request failed.', { reason: 'api_error' });
      }
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
    return _gmailAuthErr ?? notConnected('gmail', 'extract_otp', timestamp);
  }

  if (actionName.includes('attachment') || actionName.includes('parse_attachment') || actionName.includes('read_attachment')) {
    const count = payload.count || 10;
    if (accessToken) {
      console.log('[Gmail Tool] Locating and parsing attachments...');
      let emails;
      try {
        emails = await fetchRealGmailMessagesFull(accessToken, count);
      } catch (err) {
        if (err instanceof GmailHttpError) return gmailHttpFailure('extract_attachment', timestamp, err.status);
        return apiError('gmail', 'extract_attachment', timestamp, 'Gmail request failed.', { reason: 'api_error' });
      }
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
    return _gmailAuthErr ?? notConnected('gmail', 'extract_attachment', timestamp);
  }

  if (actionName.includes('draft') || actionName.includes('compose') || actionName.includes('write_email')) {
    const toEmail = payload.to || payload.recipient;
    const subject = payload.subject;
    const bodyText = payload.body || payload.content || '';

    if (!toEmail) return { tool: 'gmail', action: 'draft_email', status: 'error' as const, message: 'Recipient email (to/recipient) is required.', data: null, timestamp };
    if (!subject) return { tool: 'gmail', action: 'draft_email', status: 'error' as const, message: 'Email subject is required.', data: null, timestamp };

    if (!accessToken) return _gmailAuthErr ?? notConnected('gmail', 'draft_email', timestamp);

    try {
      const base64EncodedEmail = buildRawEmail({ to: toEmail, subject, body: bodyText, cc: payload.cc, bcc: payload.bcc });

      const draftRes = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
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
      if (!draftRes.ok) {
        if (draftRes.status === 401 || draftRes.status === 403) {
          return gmailHttpFailure('draft_email', timestamp, draftRes.status);
        }
        return {
          tool: 'gmail',
          action: 'draft_email',
          status: 'error' as const,
          message: `Gmail draft failed: HTTP ${draftRes.status} ${await draftRes.text().catch(() => '')}`,
          data: null,
          timestamp,
        };
      }
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
      const base64EncodedEmail = buildRawEmail({ to: toEmail, subject, body: bodyText, cc: payload.cc, bcc: payload.bcc });

      const sendRes = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
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

      if (sendRes.status === 401 || sendRes.status === 403) {
        return gmailHttpFailure('send_email', timestamp, sendRes.status);
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

  return _gmailAuthErr ?? notConnected('gmail', 'send_email', timestamp);
}

export const gmail: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
