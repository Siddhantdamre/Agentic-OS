import http from 'http';
import { Pool } from 'pg';

export interface ToolExecutionParams {
  tool: string;
  action: string;
  payload: Record<string, any>;
  orgId: string;
}

export interface ToolExecutionResult {
  tool: string;
  action: string;
  status: 'executed' | 'simulated' | 'error';
  message: string;
  data: any;
  timestamp: string;
}

const NANGO_HOST = process.env.NANGO_HOST || 'http://localhost:3003';
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY; // Must be set — no insecure fallback

// Shared connection pool — avoids leaking a new Pool per tool call.
const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
  max: 10,
});

/**
 * Fetch Nango connection tokens for a provider
 */
async function getNangoAccessToken(connectionId: string, providerKey: string): Promise<string | null> {
  const data = await getNangoConnection(connectionId, providerKey);
  return data?.credentials?.raw?.access_token || data?.credentials?.access_token || null;
}

/**
 * Fetch full Nango connection for a provider to access metadata
 */
async function getNangoConnection(connectionId: string, providerKey: string): Promise<any | null> {
  if (!NANGO_SECRET_KEY) {
    console.warn('[Tool Executor] NANGO_SECRET_KEY is not set — cannot fetch OAuth token');
    return null;
  }
  try {
    const res = await fetch(`${NANGO_HOST}/connection/${connectionId}?provider_config_key=${providerKey}`, {
      headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` },
    });
    if (!res.ok) {
      console.warn(`[Nango] Token fetch failed for ${connectionId} (${providerKey}): HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err: any) {
    console.warn(`[Nango] Token fetch error for ${connectionId}:`, err.message);
    return null;
  }
}

/**
 * Build a structured 'not_connected' response when a tool has no Nango token
 */
function notConnected(tool: string, action: string, timestamp: string): ToolExecutionResult {
  return {
    tool,
    action,
    status: 'simulated',
    message: `${tool} not connected. Authorize via Nango OAuth at /connectors to enable real actions.`,
    data: { connected: false, setupUrl: '/connectors' },
    timestamp,
  };
}

/**
 * Fetch real live emails from Gmail API using OAuth access token
 */
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

/**
 * Decode Gmail base64url-encoded content
 */
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

/**
 * Recursively extract plain-text body from a Gmail message payload
 */
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

/**
 * Fetch a single Gmail message with the full body + attachment metadata
 */
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
 * Fetch latest Gmail messages with full bodies + attachment metadata
 */
async function fetchRealGmailMessagesFull(accessToken: string, count: number = 10): Promise<any[]> {
  try {
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listRes.ok) return [];
    const listData = await listRes.json();
    const messageList = listData.messages || [];
    const results = await Promise.all(
      messageList.map(async (m: any) => fetchGmailMessageFull(accessToken, m.id))
    );
    return results.filter(Boolean);
  } catch (err) {
    console.error('Gmail Full Fetch Error:', err);
    return [];
  }
}

/**
 * Download and return the raw bytes of a Gmail attachment
 */
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

/**
 * Heuristic triage classification for a fetched email
 */
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

/**
 * Extract likely OTP/verification codes from a body (keyword-anchored to reduce noise)
 */
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

/**
 * Compute free time slots across a window given busy events
 */
function computeFreeSlots(
  busyEvents: Array<{ start: Date; end: Date }>,
  start: Date,
  end: Date,
  dayStartMin: number,
  dayEndMin: number,
  durationMin: number
): Array<{ start: string; end: string }> {
  const slots: Array<{ start: string; end: string }> = [];
  const dayMs = 86400000;
  const maxDays = 14;
  let cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  let days = 0;
  while (cursor <= end && days < maxDays) {
    const workStart = new Date(cursor.getTime() + dayStartMin * 60000);
    const workEnd = new Date(cursor.getTime() + dayEndMin * 60000);
    const dayEvents = busyEvents
      .filter((e) => e.end > workStart && e.start < workEnd)
      .map((e) => ({
        start: e.start < workStart ? workStart : e.start,
        end: e.end > workEnd ? workEnd : e.end,
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    let freeFrom = workStart;
    for (const ev of dayEvents) {
      if (ev.start.getTime() - freeFrom.getTime() >= durationMin * 60000) {
        slots.push({ start: freeFrom.toISOString(), end: ev.start.toISOString() });
      }
      if (ev.end > freeFrom) freeFrom = ev.end;
    }
    if (workEnd.getTime() - freeFrom.getTime() >= durationMin * 60000) {
      slots.push({ start: freeFrom.toISOString(), end: workEnd.toISOString() });
    }
    cursor = new Date(cursor.getTime() + dayMs);
    days += 1;
  }
  return slots;
}

export async function executeAutonomousToolAction(
  params: ToolExecutionParams
): Promise<ToolExecutionResult> {
  const timestamp = new Date().toISOString();
  const actionName = (params.action || 'auto_execute').toLowerCase();
  console.log(`[Autonomous Tool Execution] Tool: ${params.tool}, Action: ${actionName}, Org: ${params.orgId}`);

  try {
    switch (params.tool.toLowerCase()) {
      case 'sandbox':
      case 'code_execution':
      case 'execute_code': {
        console.log(`[Agent-Infra Sandbox] Executing secure cloud sandbox code for ${params.orgId}...`);
        try {
          const { SandboxClient } = await import('@agent-infra/sandbox');
          const client = new SandboxClient({
            environment: process.env.SANDBOX_API_URL || 'http://localhost:8080',
          });
          
          const language = (params.payload.language === 'javascript' || params.payload.language === 'node') ? 'javascript' : 'python';
          
          let codeToRun = params.payload.code || params.payload.expression || params.payload.command;
          if (!codeToRun) {
            if (params.payload.num1 !== undefined && params.payload.num2 !== undefined) {
              const opStr = (params.payload.operator || params.payload.operation || '*').toString().toLowerCase();
              let symbol = '*';
              if (opStr.includes('add') || opStr.includes('plus') || opStr === '+') symbol = '+';
              else if (opStr.includes('sub') || opStr.includes('minus') || opStr === '-') symbol = '-';
              else if (opStr.includes('div') || opStr.includes('slash') || opStr === '/') symbol = '/';
              else if (opStr.includes('mult') || opStr.includes('times') || opStr.includes('prod') || opStr === '*') symbol = '*';
              codeToRun = `print(${params.payload.num1} ${symbol} ${params.payload.num2})`;
            } else {
              codeToRun = `print(${JSON.stringify(params.payload)})`;
            }
          }

          const execResult = await client.code.executeCode({
            code: codeToRun,
            language: language,
          });
          
          const bodyData = (execResult as any)?.body?.data || (execResult as any)?.data || {};
          const textOutput = bodyData.stdout || bodyData.text || (execResult as any).output || JSON.stringify(execResult);
          
          return {
            tool: params.tool,
            action: params.action,
            status: 'executed',
            message: 'Code executed securely in Agent-Infra Sandbox',
            data: {
              output: textOutput,
            },
            timestamp,
          };
        } catch (err: any) {
          console.error('[Agent-Infra Sandbox Error]', err);
          return {
            tool: params.tool,
            action: params.action,
            status: 'error',
            message: 'Failed to execute code in Agent-Infra sandbox',
            data: { error: err.message },
            timestamp,
          };
        }
      }

      case 'web_search':
      case 'search':
      case 'google_search': {
        const query = params.payload.query || params.payload.q || params.payload.search;
        if (!query) {
          return { tool: 'web_search', action: 'search', status: 'error', message: 'Search query is required', data: null, timestamp };
        }
        console.log(`[Web Search Tool] Performing live web search for: "${query}"...`);
        try {
          const searchRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          const html = await searchRes.text();
          const results: Array<{ title: string; snippet: string; url: string }> = [];
          const matches = html.matchAll(/<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
          for (const match of matches) {
            if (results.length >= 5) break;
            const snippet = match[2].replace(/<[^>]+>/g, '').trim();
            results.push({ title: query, snippet, url: match[1] });
          }
          return {
            tool: 'web_search',
            action: 'search',
            status: results.length > 0 ? 'executed' : 'error',
            message: results.length > 0
              ? `✅ Found ${results.length} live web search results for "${query}"`
              : `No web search results found for "${query}"`,
            data: { query, results },
            timestamp,
          };
        } catch (err: any) {
          return { tool: 'web_search', action: 'search', status: 'error', message: `Search failed: ${err.message}`, data: null, timestamp };
        }
      }

      case 'web_extract':
      case 'fetch_url':
      case 'read_url': {
        const url = params.payload.url || params.payload.link;
        if (!url) {
          return { tool: 'web_extract', action: 'extract', status: 'error', message: 'URL parameter is required', data: null, timestamp };
        }
        console.log(`[Web Extract Tool] Extracting web content from ${url}...`);
        try {
          const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
          const rawText = await pageRes.text();
          const cleanText = rawText
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000);
          return {
            tool: 'web_extract',
            action: 'extract',
            status: 'executed',
            message: `Extracted ${cleanText.length} characters of clean text from ${url}`,
            data: { url, content: cleanText },
            timestamp,
          };
        } catch (err: any) {
          return { tool: 'web_extract', action: 'extract', status: 'error', message: `Failed to extract URL: ${err.message}`, data: null, timestamp };
        }
      }

      case 'database_query':
      case 'db_query':
      case 'sql_analytics': {
        let sql = params.payload.sql || (typeof params.payload.query === 'string' && params.payload.query.toLowerCase().trim().startsWith('select') ? params.payload.query : null);
        if (!sql) {
          const queryType = (params.payload.queryType || params.payload.table || actionName || '').toString().toLowerCase();
          if (queryType.includes('employee')) {
            sql = 'SELECT id, name, role, status FROM ai_employees LIMIT 10';
          } else if (queryType.includes('channel') || queryType.includes('log')) {
            sql = 'SELECT id, channel_type, event_type, status FROM channel_logs ORDER BY created_at DESC LIMIT 10';
          } else {
            sql = 'SELECT id, name, role, status FROM ai_employees LIMIT 10';
          }
        }
        if (!sql.toLowerCase().trim().startsWith('select')) {
          return { tool: 'database_query', action: 'query', status: 'error', message: 'Security Policy: Only SELECT queries are permitted', data: null, timestamp };
        }
        try {
          const client = await dbPool.connect();
          try {
            await client.query("SELECT set_config('app.current_org_id', $1, true)", [params.orgId]);
            const dbRes = await client.query(sql);
            return {
              tool: 'database_query',
              action: 'query',
              status: 'executed',
              message: `✅ SQL query executed safely. Returned ${dbRes.rows.length} rows`,
              data: { rows: dbRes.rows.slice(0, 25), totalRows: dbRes.rows.length },
              timestamp,
            };
          } finally {
            client.release();
          }
        } catch (err: any) {
          return { tool: 'database_query', action: 'query', status: 'error', message: `Database query failed: ${err.message}`, data: null, timestamp };
        }
      }

      case 'file_ops':
      case 'file_system':
      case 'workspace_file': {
        const fileAction = actionName || params.payload.fileAction || 'read';
        const filePath = params.payload.path || params.payload.filePath || 'notes.txt';
        const fs = require('fs');
        const path = require('path');
        const baseDir = path.resolve(process.cwd(), 'workspace_storage', params.orgId || 'default');

        if (!fs.existsSync(baseDir)) {
          fs.mkdirSync(baseDir, { recursive: true });
        }

        const safePath = path.join(baseDir, path.basename(filePath));

        if (fileAction.includes('write') || fileAction.includes('create')) {
          const content = params.payload.content || params.payload.text || '';
          fs.writeFileSync(safePath, content, 'utf8');
          return {
            tool: 'file_ops',
            action: 'write_file',
            status: 'executed',
            message: `✅ Created file ${path.basename(filePath)} (${content.length} bytes)`,
            data: { filePath: safePath, fileName: path.basename(filePath), size: content.length },
            timestamp,
          };
        } else {
          if (fs.existsSync(safePath)) {
            const content = fs.readFileSync(safePath, 'utf8');
            return {
              tool: 'file_ops',
              action: 'read_file',
              status: 'executed',
              message: `Read ${content.length} characters from ${path.basename(filePath)}`,
              data: { fileName: path.basename(filePath), content },
              timestamp,
            };
          } else {
            return {
              tool: 'file_ops',
              action: 'read_file',
              status: 'error',
              message: `File ${path.basename(filePath)} does not exist in workspace`,
              data: null,
              timestamp,
            };
          }
        }
      }
      
      case 'gmail': {
        const gmailConnId = `${params.orgId}_gmail`;
        let gmailToken: string | null = null;
        for (const providerKey of ['gmail', 'google-mail', 'google']) {
          gmailToken = await getNangoAccessToken(gmailConnId, providerKey);
          if (gmailToken) break;
        }
        const accessToken = gmailToken;

        // Fetch latest emails (full bodies + attachment metadata)
        if (actionName.includes('fetch') || actionName.includes('read') || actionName.includes('list')) {
          const count = params.payload.count || 10;

          if (accessToken) {
            console.log(`[Gmail Tool] Fetching real live emails using OAuth access token for connection ${gmailConnId}...`);
            const realEmails = await fetchRealGmailMessagesFull(accessToken, count);

            return {
              tool: 'gmail',
              action: 'fetch_latest_emails',
              status: 'executed',
              message: `Fetched ${realEmails.length} real live emails from connected Gmail account`,
              data: {
                totalFetched: realEmails.length,
                filter: params.payload.filter || 'inbox',
                emails: realEmails,
              },
              timestamp,
            };
          }

          return notConnected('gmail', 'fetch_latest_emails', timestamp);
        }

        // Triage / classify inbox
        if (actionName.includes('triage') || actionName.includes('classify')) {
          const count = params.payload.count || 10;
          if (accessToken) {
            console.log('[Gmail Tool] Triaging inbox...');
            const emails = await fetchRealGmailMessagesFull(accessToken, count);
            const categorized = emails.map((e) => ({ ...e, category: classifyEmail(e) }));
            const summary: Record<string, number> = {};
            for (const em of categorized) summary[em.category] = (summary[em.category] || 0) + 1;
            return {
              tool: 'gmail',
              action: 'triage_emails',
              status: 'executed',
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

        // Extract OTP / verification codes from recent mail
        if (actionName.includes('otp') || actionName.includes('verification_code') || actionName.includes('extract_otp')) {
          const count = params.payload.count || 10;
          if (accessToken) {
            console.log('[Gmail Tool] Scanning mail for OTP / verification codes...');
            const emails = await fetchRealGmailMessagesFull(accessToken, count);
            const found: Array<{ code: string; context: string; from: string; subject: string; date: string; messageId: string }> = [];
            for (const em of emails) {
              for (const hit of extractOtpsFromText(`${em.body}\n${em.subject}`)) {
                found.push({ ...hit, from: em.from, subject: em.subject, date: em.date, messageId: em.id });
              }
            }
            return {
              tool: 'gmail',
              action: 'extract_otp',
              status: 'executed',
              message: found.length
                ? `Found ${found.length} verification code${found.length > 1 ? 's' : ''} in the latest ${emails.length} emails`
                : `No verification codes found in the latest ${emails.length} emails`,
              data: { scannedEmails: emails.length, codes: found },
              timestamp,
            };
          }
          return notConnected('gmail', 'extract_otp', timestamp);
        }

        // Extract + parse an attachment from recent mail (PDF/text)
        if (actionName.includes('attachment') || actionName.includes('parse_attachment') || actionName.includes('read_attachment')) {
          const count = params.payload.count || 10;
          if (accessToken) {
            console.log('[Gmail Tool] Locating and parsing attachments...');
            const emails = await fetchRealGmailMessagesFull(accessToken, count);
            const targetSubject = (params.payload.subject || '').toLowerCase();
            const targetFilename = (params.payload.filename || '').toLowerCase();

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
                status: 'error',
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
                tool: 'gmail', action: 'extract_attachment', status: 'error',
                message: `Failed to download attachment "${att.filename}"`, data: null, timestamp,
              };
            }

            let content = '';
            let parseType = 'unsupported';
            const isPdf = att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf');
            const isText = att.mimeType.startsWith('text/') || /\.(txt|csv|md|json|log)$/i.test(att.filename);
            if (isPdf) {
              try {
                const pdfParse = require('pdf-parse');
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
              status: 'executed',
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

        // Create a draft (does NOT send — user reviews first)
        if (actionName.includes('draft') || actionName.includes('compose') || actionName.includes('write_email')) {
          const toEmail = params.payload.to || params.payload.recipient;
          const subject = params.payload.subject;
          const bodyText = params.payload.body || params.payload.content || '';

          if (!toEmail) return { tool: 'gmail', action: 'draft_email', status: 'error', message: 'Recipient email (to/recipient) is required.', data: null, timestamp };
          if (!subject) return { tool: 'gmail', action: 'draft_email', status: 'error', message: 'Email subject is required.', data: null, timestamp };

          if (!accessToken) return notConnected('gmail', 'draft_email', timestamp);

          try {
            const rawEmail = [
              `To: ${toEmail}`,
              `Subject: ${subject}`,
              ...(params.payload.cc ? [`Cc: ${params.payload.cc}`] : []),
              ...(params.payload.bcc ? [`Bcc: ${params.payload.bcc}`] : []),
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
                status: 'executed',
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
              status: 'error',
              message: `Gmail draft failed: HTTP ${draftRes.status} ${await draftRes.text().catch(() => '')}`,
              data: null,
              timestamp,
            };
          } catch (e: any) {
            console.error('[Gmail Tool] Draft error:', e);
            return { tool: 'gmail', action: 'draft_email', status: 'error', message: `Gmail draft error: ${e.message}`, data: null, timestamp };
          }
        }

        // Outbound send_email
        const toEmail = params.payload.to || params.payload.recipient;
        const subject = params.payload.subject;
        const bodyText = params.payload.body || params.payload.content || '';

        if (!toEmail) {
          return {
            tool: 'gmail',
            action: 'send_email',
            status: 'error',
            message: 'Recipient email parameter (to/recipient) is required.',
            data: null,
            timestamp,
          };
        }
        if (!subject) {
          return {
            tool: 'gmail',
            action: 'send_email',
            status: 'error',
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
                status: 'executed',
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

            // Connected, but the send failed — report the real error, not "not connected"
            return {
              tool: 'gmail',
              action: 'send_email',
              status: 'error',
              message: `Gmail send failed: HTTP ${sendRes.status} ${await sendRes.text().catch(() => '')}`,
              data: null,
              timestamp,
            };
          } catch (e: any) {
            console.error('Gmail real send error:', e);
            return {
              tool: 'gmail',
              action: 'send_email',
              status: 'error',
              message: `Gmail send error: ${e.message}`,
              data: null,
              timestamp,
            };
          }
        }

        // Not connected — honest response, no fake messageId
        return notConnected('gmail', 'send_email', timestamp);
      }

      case 'google-calendar': {
        const summary = params.payload.summary || params.payload.title;
        const startIso = params.payload.startTime;
        const calAction = params.action || params.payload.calAction || 'create_event';
        const connId = `${params.orgId}_google-calendar`;

        // Try multiple Nango provider config keys (varies by Nango setup)
        let accessToken: string | null = null;
        for (const providerKey of ['google-calendar', 'google-calendar-v2', 'google']) {
          accessToken = await getNangoAccessToken(connId, providerKey);
          if (accessToken) break;
        }

        if (accessToken) {
          try {
            // LIST events
            if (calAction === 'list_events' || calAction === 'fetch_events') {
              const timeMin = new Date().toISOString();
              const timeMax = new Date(Date.now() + 7 * 86400000).toISOString();
              const listRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=10`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (listRes.ok) {
                const listData = await listRes.json();
                const events = listData.items || [];
                return {
                  tool: 'google-calendar',
                  action: 'list_events',
                  status: 'executed',
                  message: `✅ Fetched ${events.length} upcoming events from your Google Calendar`,
                  data: {
                    totalEvents: events.length,
                    events: events.map((e: any) => ({
                      id: e.id,
                      summary: e.summary,
                      start: e.start?.dateTime || e.start?.date,
                      end: e.end?.dateTime || e.end?.date,
                      hangoutLink: e.hangoutLink,
                      htmlLink: e.htmlLink,
                    })),
                  },
                  timestamp,
                };
              } else {
                const errBody = await listRes.json().catch(() => ({}));
                console.error('[Google Calendar] list_events error:', listRes.status, errBody);
              }
            }

            // CHECK AVAILABILITY / FREE BUSY
            if (calAction === 'check_availability' || calAction === 'find_free_slots') {
              const winStart = params.payload.startTime || params.payload.start || new Date().toISOString();
              const winEnd = params.payload.endTime || params.payload.end || new Date(new Date(winStart).getTime() + 7 * 86400000).toISOString();
              const durationMin = parseInt(params.payload.durationMinutes || params.payload.duration || '60', 10);
              const parseHhmm = (val: any, fallback: number): number => {
                if (val === undefined || val === null || val === '') return fallback;
                const [h, m] = String(val).split(':').map(Number);
                return (isNaN(h) ? 0 : h) * 60 + (isNaN(m) ? 0 : m);
              };
              const dayStartMin = parseHhmm(params.payload.dayStart, 540);
              const dayEndMin = parseHhmm(params.payload.dayEnd, 1080);

              const availRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(winStart)}&timeMax=${encodeURIComponent(winEnd)}&singleEvents=true&orderBy=startTime&maxResults=100`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (!availRes.ok) {
                return { tool: 'google-calendar', action: 'check_availability', status: 'error', message: `Google Calendar API error ${availRes.status}`, data: null, timestamp };
              }
              const availData = await availRes.json();
              const events = (availData.items || []) as any[];
              const busy = events
                .map((e) => ({ start: new Date(e.start?.dateTime || e.start?.date), end: new Date(e.end?.dateTime || e.end?.date) }))
                .filter((e) => !isNaN(e.start.getTime()) && !isNaN(e.end.getTime()));
              const freeSlots = computeFreeSlots(busy, new Date(winStart), new Date(winEnd), dayStartMin, dayEndMin, durationMin);
              return {
                tool: 'google-calendar',
                action: 'check_availability',
                status: 'executed',
                message: `Found ${freeSlots.length} free slot${freeSlots.length === 1 ? '' : 's'} of ${durationMin}min between ${winStart} and ${winEnd}`,
                data: {
                  windowStart: winStart,
                  windowEnd: winEnd,
                  durationMinutes: durationMin,
                  freeSlots,
                  busyEvents: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
                },
                timestamp,
              };
            }

            // CREATE event
            if (!summary) {
              return {
                tool: 'google-calendar',
                action: 'create_event',
                status: 'error',
                message: 'Event summary/title parameter is required.',
                data: null,
                timestamp,
              };
            }
            if (!startIso) {
              return {
                tool: 'google-calendar',
                action: 'create_event',
                status: 'error',
                message: 'Event startTime parameter (ISO string) is required.',
                data: null,
                timestamp,
              };
            }

            const eventBody = {
              summary,
              description: params.payload.description || '',
              location: params.payload.location || '',
              start: { dateTime: startIso, timeZone: params.payload.timeZone || 'UTC' },
              end: {
                dateTime: params.payload.endTime || new Date(new Date(startIso).getTime() + 3600000).toISOString(),
                timeZone: params.payload.timeZone || 'UTC',
              },
              attendees: params.payload.attendees?.map((email: string) => ({ email })) || [],
              conferenceData: { createRequest: { requestId: `drx-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
            };

            const calRes = await fetch(
              'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
              {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(eventBody),
              }
            );

            if (calRes.ok) {
              const calData = await calRes.json();
              return {
                tool: 'google-calendar',
                action: 'create_event',
                status: 'executed',
                message: `✅ Scheduled "${calData.summary}" on Google Calendar`,
                data: {
                  eventId: calData.id,
                  summary: calData.summary,
                  startTime: calData.start?.dateTime,
                  endTime: calData.end?.dateTime,
                  hangoutLink: calData.hangoutLink || calData.conferenceData?.entryPoints?.[0]?.uri || null,
                  htmlLink: calData.htmlLink,
                  attendees: calData.attendees?.map((a: any) => a.email) || [],
                },
                timestamp,
              };
            } else {
              const errBody = await calRes.json().catch(() => ({}));
              console.error('[Google Calendar] create_event error:', calRes.status, errBody);
              return {
                tool: 'google-calendar',
                action: 'create_event',
                status: 'error',
                message: `Google Calendar API error ${calRes.status}: ${errBody?.error?.message || 'Unknown error'}`,
                data: { statusCode: calRes.status, error: errBody },
                timestamp,
              };
            }
          } catch (e: any) {
            console.error('[Google Calendar] Exception:', e.message);
            return {
              tool: 'google-calendar',
              action: calAction,
              status: 'error',
              message: `Google Calendar request failed: ${e.message}`,
              data: null,
              timestamp,
            };
          }
        }

        // Not connected — honest response, no fake data
        return notConnected('google-calendar', calAction, timestamp);
      }

      case 'github': {
        const connId = `${params.orgId}_github`;
        const accessToken = await getNangoAccessToken(connId, 'github');

        if (accessToken) {
          try {
            // CREATE ISSUE
            if (actionName.includes('issue')) {
              const repoArg = params.payload.repo || params.payload.repository || params.payload.full_name;
              const title = params.payload.title;
              if (!repoArg) {
                return { tool: 'github', action: 'create_issue', status: 'error', message: 'Repository (repo or owner/repo) is required.', data: null, timestamp };
              }
              if (!title) {
                return { tool: 'github', action: 'create_issue', status: 'error', message: 'Issue title is required.', data: null, timestamp };
              }

              const repoParts = repoArg.split('/');
              let fullRepo = repoArg;
              if (repoParts.length === 1) {
                const meRes = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'DareX-AI-Agent' } });
                const me = await meRes.json();
                fullRepo = `${me.login}/${repoParts[0]}`;
              }

              const issueRes = await fetch(`https://api.github.com/repos/${fullRepo}/issues`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'User-Agent': 'DareX-AI-Agent',
                  'Content-Type': 'application/json',
                  'Accept': 'application/vnd.github.v3+json',
                },
                body: JSON.stringify({
                  title,
                  body: params.payload.body || params.payload.description || '',
                  labels: params.payload.labels || [],
                }),
              });

              if (issueRes.ok) {
                const issue = await issueRes.json();
                return {
                  tool: 'github',
                  action: 'create_issue',
                  status: 'executed',
                  message: `Created issue #${issue.number} in ${fullRepo}`,
                  data: { number: issue.number, title: issue.title, url: issue.html_url, state: issue.state },
                  timestamp,
                };
              }
              const issueErr = await issueRes.json().catch(() => ({}));
              return { tool: 'github', action: 'create_issue', status: 'error', message: `GitHub issue creation failed: ${issueRes.status} ${issueErr.message || ''}`, data: null, timestamp };
            }

            if (actionName.includes('create')) {
              // CREATE REPO
              const repoName = params.payload.name || params.payload.repoName || 'new-repo';
              const isPrivate = params.payload.private !== undefined ? params.payload.private : true;
              
              const createRes = await fetch('https://api.github.com/user/repos', {
                method: 'POST',
                headers: { 
                  Authorization: `Bearer ${accessToken}`, 
                  'User-Agent': 'DareX-AI-Agent',
                  'Content-Type': 'application/json',
                  'Accept': 'application/vnd.github.v3+json'
                },
                body: JSON.stringify({ name: repoName, private: isPrivate })
              });
              
              if (createRes.ok) {
                const repo = await createRes.json();
                return {
                  tool: 'github',
                  action: 'create_repo',
                  status: 'executed',
                  message: `Successfully created repository '${repo.name}' on GitHub`,
                  data: {
                    name: repo.name,
                    full_name: repo.full_name,
                    url: repo.html_url,
                    private: repo.private
                  },
                  timestamp,
                };
              } else {
                const errData = await createRes.json();
                console.error('GitHub API Create Error:', errData);
              }
            } else {
              // FETCH REPOS
              const ghRes = await fetch('https://api.github.com/user/repos?sort=updated&per_page=5', {
                headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'DareX-AI-Agent' },
              });
              if (ghRes.ok) {
                const repos = await ghRes.json();
                return {
                  tool: 'github',
                  action: 'fetch_user_repos',
                  status: 'executed',
                  message: `Fetched ${repos.length} live repositories from connected GitHub account`,
                  data: {
                    totalRepos: repos.length,
                    repositories: repos.map((r: any) => ({ name: r.name, full_name: r.full_name, private: r.private, url: r.html_url })),
                  },
                  timestamp,
                };
              }
            }
          } catch (e: any) {
            console.error('GitHub API error:', e);
          }
        }

        return notConnected('github', actionName, timestamp);
      }

      case 'whatsapp': {
        const phone = params.payload.phone || params.payload.contactId || params.payload.to;
        const textMsg = params.payload.message || params.payload.content || params.payload.body;

        if (!textMsg) {
          return {
            tool: 'whatsapp',
            action: 'send_whatsapp_message',
            status: 'error',
            message: 'Message text parameter (message/content/body) is required',
            data: null,
            timestamp,
          };
        }

        if (!phone) {
          return {
            tool: 'whatsapp',
            action: 'send_whatsapp_message',
            status: 'error',
            message: 'Phone number is required to send WhatsApp message',
            data: null,
            timestamp,
          };
        }

        const dbRes = await dbPool.query('SELECT meta, nango_connection_id FROM channels WHERE org_id = $1 AND channel_type = $2', [params.orgId, 'whatsapp']);
        let metaAccessToken = null;
        let phoneNumberId = params.payload.phoneNumberId;
        
        const channel = dbRes.rows[0] as any;
        if (channel?.meta?.accessToken) {
          metaAccessToken = channel.meta.accessToken;
          phoneNumberId = phoneNumberId || channel.meta.phoneNumberId;
        } else if (channel?.nango_connection_id?.startsWith('manual_json:')) {
          // Backward compat: legacy rows stored manual creds inside nango_connection_id
          const creds = JSON.parse(channel.nango_connection_id.split('manual_json:')[1]);
          metaAccessToken = creds.accessToken;
          phoneNumberId = phoneNumberId || creds.phoneNumberId;
        } else {
          // Fallback to Nango OAuth
          const connId = `${params.orgId}_whatsapp`;
          const nangoData = await getNangoConnection(connId, 'whatsapp');
          metaAccessToken = nangoData?.credentials?.raw?.access_token || nangoData?.credentials?.access_token || null;
          
          phoneNumberId = phoneNumberId 
            || nangoData?.metadata?.phone_number_id 
            || nangoData?.credentials?.raw?.phone_number_id
            || process.env.WHATSAPP_PHONE_NUMBER_ID;
        }

        if (metaAccessToken && phoneNumberId) {
          try {
            const metaRes = await fetch(
              `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${metaAccessToken}`,
                },
                body: JSON.stringify({
                  messaging_product: 'whatsapp',
                  to: phone,
                  type: 'text',
                  text: { body: textMsg },
                }),
              }
            );

            if (metaRes.ok) {
              const metaData = await metaRes.json();
              const wamid = metaData.messages?.[0]?.id;
              if (!wamid) {
                return {
                  tool: 'whatsapp',
                  action: 'send_whatsapp_message',
                  status: 'error',
                  message: 'Meta API responded OK but returned no message id',
                  data: { recipientPhone: phone, meta_response: metaData },
                  timestamp,
                };
              }
              return {
                tool: 'whatsapp',
                action: 'send_whatsapp_message',
                status: 'executed',
                message: `✅ Real WhatsApp message delivered to ${phone} via Meta Cloud API`,
                data: {
                  wamid,
                  recipientPhone: phone,
                  content: textMsg,
                  meta_response: metaData,
                },
                timestamp,
              };
            } else {
              const errText = await metaRes.text();
              console.error('[WhatsApp Tool] Meta API error:', errText);
              return {
                tool: 'whatsapp',
                action: 'send_whatsapp_message',
                status: 'error',
                message: `Meta API returned ${metaRes.status}: ${errText.slice(0, 200)}`,
                data: { recipientPhone: phone },
                timestamp,
              };
            }
          } catch (err: any) {
            console.error('[WhatsApp Tool] Network error:', err);
            return {
              tool: 'whatsapp',
              action: 'send_whatsapp_message',
              status: 'error',
              message: `Network error sending WhatsApp: ${err.message}`,
              data: null,
              timestamp,
            };
          }
        }

        // Not connected via Nango (or missing phoneNumberId)
        return notConnected('whatsapp', 'send_whatsapp_message', timestamp);
      }

      case 'hubspot': {
        const contactEmail = params.payload.email;

        if (actionName.includes('update') || actionName.includes('edit')) {
          if (!contactEmail) {
            return {
              tool: 'hubspot', action: 'update_contact', status: 'error',
              message: 'Contact email is required to update a contact in HubSpot', data: null, timestamp,
            };
          }
          const connId = `${params.orgId}_hubspot`;
          const accessToken = await getNangoAccessToken(connId, 'hubspot');
          if (accessToken) {
            try {
              // Resolve contact id by email
              const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contactEmail }] }],
                  limit: 1,
                }),
              });
              if (!searchRes.ok) {
                return { tool: 'hubspot', action: 'update_contact', status: 'error', message: `HubSpot search failed: HTTP ${searchRes.status}`, data: null, timestamp };
              }
              const searchData = await searchRes.json();
              const contactId = searchData.results?.[0]?.id;
              if (!contactId) {
                return { tool: 'hubspot', action: 'update_contact', status: 'error', message: `No HubSpot contact found with email ${contactEmail}`, data: null, timestamp };
              }

              const properties: Record<string, string> = {};
              const editable = ['firstname', 'lastname', 'phone', 'jobtitle', 'lifecyclestage', 'company', 'website', 'address', 'city', 'country', 'notes_last_contacted', 'hs_lead_status'];
              for (const key of editable) {
                if (params.payload[key] !== undefined && params.payload[key] !== null) properties[key] = String(params.payload[key]);
              }
              if (Object.keys(properties).length === 0) {
                return { tool: 'hubspot', action: 'update_contact', status: 'error', message: 'No updatable fields supplied (try firstname, lastname, phone, jobtitle, lifecyclestage, company)', data: null, timestamp };
              }

              const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ properties }),
              });
              if (updateRes.ok) {
                const hsData = await updateRes.json();
                return {
                  tool: 'hubspot', action: 'update_contact', status: 'executed',
                  message: `Updated HubSpot contact ${contactEmail}`,
                  data: { contactId: hsData.id, email: contactEmail, updatedProperties: properties },
                  timestamp,
                };
              }
              const errBody = await updateRes.json().catch(() => ({}));
              return { tool: 'hubspot', action: 'update_contact', status: 'error', message: `HubSpot update failed: HTTP ${updateRes.status} ${errBody?.message || ''}`, data: null, timestamp };
            } catch (e: any) {
              console.error('[HubSpot Tool] update error:', e);
              return { tool: 'hubspot', action: 'update_contact', status: 'error', message: `HubSpot update error: ${e.message}`, data: null, timestamp };
            }
          }
          return notConnected('hubspot', 'update_contact', timestamp);
        }

        if (!contactEmail) {
          return {
            tool: 'hubspot',
            action: 'create_crm_contact',
            status: 'error',
            message: 'Contact email parameter is required to create a contact in HubSpot',
            data: null,
            timestamp,
          };
        }
        const connId = `${params.orgId}_hubspot`;
        const accessToken = await getNangoAccessToken(connId, 'hubspot');

        if (accessToken) {
          try {
            const hsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                properties: {
                  email: contactEmail,
                  firstname: params.payload.firstname || '',
                  lastname: params.payload.lastname || '',
                  lifecyclestage: 'lead',
                },
              }),
            });

            if (hsRes.ok) {
              const hsData = await hsRes.json();
              return {
                tool: 'hubspot',
                action: 'create_crm_contact',
                status: 'executed',
                message: `✅ Created contact ${contactEmail} in HubSpot CRM`,
                data: {
                  vid: hsData.id,
                  email: contactEmail,
                  firstname: params.payload.firstname || '',
                  lastname: params.payload.lastname || '',
                  lifecycleStage: 'lead',
                },
                timestamp,
              };
            }
          } catch (e: any) {
            console.error('[HubSpot Tool] API error:', e);
          }
        }

        // Not connected — honest response, no fake HubSpot vid
        return notConnected('hubspot', 'create_crm_contact', timestamp);
      }

      case 'meta-ads': {
        const metaAdsConnId = `${params.orgId}_meta-ads`;
        const metaAdsToken = await getNangoAccessToken(metaAdsConnId, 'meta-ads');
        if (metaAdsToken) {
          try {
            const adAccountId = params.payload.adAccountId || process.env.META_AD_ACCOUNT_ID;
            if (adAccountId) {
              const fields = 'campaign_name,impressions,clicks,ctr,spend,reach';
              const metaRes = await fetch(
                `https://graph.facebook.com/v18.0/${adAccountId}/insights?fields=${fields}&date_preset=last_7d`,
                { headers: { Authorization: `Bearer ${metaAdsToken}` } }
              );
              if (metaRes.ok) {
                const metaData = await metaRes.json();
                return {
                  tool: 'meta-ads',
                  action: 'fetch_campaign_metrics',
                  status: 'executed',
                  message: `Fetched live Meta Ads campaign metrics for account ${adAccountId}`,
                  data: { campaigns: metaData.data || [], paging: metaData.paging },
                  timestamp,
                };
              }
            }
          } catch (e: any) {
            console.error('[Meta Ads] API error:', e.message);
          }
        }
        return notConnected('meta-ads', 'fetch_campaign_metrics', timestamp);
      }

      case 'google-ads': {
        const googleAdsConnId = `${params.orgId}_google-ads`;
        const googleAdsToken = await getNangoAccessToken(googleAdsConnId, 'google-ads');
        if (googleAdsToken) {
          try {
            const customerId = params.payload.customerId || process.env.GOOGLE_ADS_CUSTOMER_ID;
            if (customerId) {
              const gaRes = await fetch(
                `https://googleads.googleapis.com/v14/customers/${customerId}/googleAds:search`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${googleAdsToken}`,
                    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    query: `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS`,
                  }),
                }
              );
              if (gaRes.ok) {
                const gaData = await gaRes.json();
                return {
                  tool: 'google-ads',
                  action: 'fetch_campaign_metrics',
                  status: 'executed',
                  message: `Fetched live Google Ads campaign metrics for customer ${customerId}`,
                  data: { results: gaData.results || [] },
                  timestamp,
                };
              }
            }
          } catch (e: any) {
            console.error('[Google Ads] API error:', e.message);
          }
        }
        return notConnected('google-ads', 'fetch_campaign_metrics', timestamp);
      }

      case 'slack': {
        const slackConnId = `${params.orgId}_slack`;
        const slackToken = await getNangoAccessToken(slackConnId, 'slack');
        if (slackToken) {
          try {
            const channel = params.payload.channel || '#general';
            const text = params.payload.message || params.payload.text || 'Notification from DareX AI';
            const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel, text }),
            });
            if (slackRes.ok) {
              const slackData = await slackRes.json();
              if (slackData.ok) {
                return {
                  tool: 'slack',
                  action: 'send_channel_message',
                  status: 'executed',
                  message: `✅ Sent message to ${channel} via Slack API`,
                  data: { channel, ts: slackData.ts, messageSent: true },
                  timestamp,
                };
              }
              return {
                tool: 'slack', action: 'send_channel_message', status: 'error',
                message: `Slack API error: ${slackData.error}`, data: null, timestamp,
              };
            }
          } catch (e: any) {
            console.error('[Slack] API error:', e.message);
          }
        }
        return notConnected('slack', 'send_channel_message', timestamp);
      }

      case 'notion': {
        const notionConnId = `${params.orgId}_notion`;
        const notionToken = await getNangoAccessToken(notionConnId, 'notion');
        if (notionToken) {
          try {
            // APPEND CONTENT TO EXISTING PAGE
            if (actionName.includes('append') || actionName.includes('add_content') || actionName.includes('update_content')) {
              const pageId = params.payload.pageId || params.payload.page_id || params.payload.parentId;
              const content = params.payload.content || params.payload.text || '';
              if (!pageId) {
                return { tool: 'notion', action: 'append_page_content', status: 'error', message: 'Page id (pageId) is required to append content.', data: null, timestamp };
              }
              if (!content) {
                return { tool: 'notion', action: 'append_page_content', status: 'error', message: 'Content text is required to append.', data: null, timestamp };
              }
              const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
              const children = lines.map((l: string) => ({
                object: 'block' as const,
                type: 'paragraph' as const,
                paragraph: { rich_text: [{ type: 'text', text: { content: l.slice(0, 2000) } }] },
              }));
              const appendRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${notionToken}`,
                  'Content-Type': 'application/json',
                  'Notion-Version': '2022-06-28',
                },
                body: JSON.stringify({ children }),
              });
              if (appendRes.ok) {
                const appended = await appendRes.json();
                return {
                  tool: 'notion',
                  action: 'append_page_content',
                  status: 'executed',
                  message: `Appended ${children.length} block${children.length === 1 ? '' : 's'} to Notion page ${pageId}`,
                  data: { pageId, blocksAppended: children.length, blockIds: (appended.results || []).map((b: any) => b.id) },
                  timestamp,
                };
              }
              const appendErr = await appendRes.json().catch(() => ({}));
              return { tool: 'notion', action: 'append_page_content', status: 'error', message: `Notion append failed: ${appendRes.status} ${appendErr.message || ''}`, data: null, timestamp };
            }

            if (actionName.includes('create') || actionName.includes('add')) {
              const title = params.payload.title || 'Untitled Page';
              const parentPageId = params.payload.parentPageId || params.payload.parentId;
              const notionRes = await fetch('https://api.notion.com/v1/pages', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${notionToken}`,
                  'Content-Type': 'application/json',
                  'Notion-Version': '2022-06-28',
                },
                body: JSON.stringify({
                  parent: parentPageId ? { page_id: parentPageId } : { type: 'workspace', workspace: true },
                  properties: {
                    title: { title: [{ text: { content: title } }] },
                  },
                }),
              });
              if (notionRes.ok) {
                const pageData = await notionRes.json();
                return {
                  tool: 'notion',
                  action: 'create_page',
                  status: 'executed',
                  message: `✅ Created Notion page "${title}"`,
                  data: { id: pageData.id, url: pageData.url, title },
                  timestamp,
                };
              }
            } else {
              const query = params.payload.query || '';
              const notionRes = await fetch('https://api.notion.com/v1/search', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${notionToken}`,
                  'Content-Type': 'application/json',
                  'Notion-Version': '2022-06-28',
                },
                body: JSON.stringify({ query, page_size: 10 }),
              });
              if (notionRes.ok) {
                const notionData = await notionRes.json();
                return {
                  tool: 'notion',
                  action: 'search_workspace_docs',
                  status: 'executed',
                  message: `Searched Notion workspace for: "${query}"`,
                  data: { results: notionData.results || [], totalResults: notionData.results?.length || 0 },
                  timestamp,
                };
              }
            }
          } catch (e: any) {
            console.error('[Notion] API error:', e.message);
          }
        }
        return notConnected('notion', actionName, timestamp);
      }

      case 'stripe': {
        const stripeConnId = `${params.orgId}_stripe`;
        const stripeToken = await getNangoAccessToken(stripeConnId, 'stripe');
        if (stripeToken) {
          try {
            if (actionName.includes('customer')) {
              const email = params.payload.email;
              const name = params.payload.name;
              const stripeRes = await fetch('https://api.stripe.com/v1/customers', {
                method: actionName.includes('create') ? 'POST' : 'GET',
                headers: {
                  Authorization: `Bearer ${stripeToken}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: actionName.includes('create') && email ? new URLSearchParams({ email, name: name || '' }) : undefined,
              });
              if (stripeRes.ok) {
                const customerData = await stripeRes.json();
                return {
                  tool: 'stripe',
                  action: actionName,
                  status: 'executed',
                  message: `Stripe customer action completed`,
                  data: customerData,
                  timestamp,
                };
              }
            } else {
              const amount = params.payload.amount || 5000; // cents
              const currency = params.payload.currency || 'usd';
              const productName = params.payload.name || 'DareX AI Service';
              const stripeRes = await fetch('https://api.stripe.com/v1/payment_links', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${stripeToken}`,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  'line_items[0][price_data][currency]': currency,
                  'line_items[0][price_data][product_data][name]': productName,
                  'line_items[0][price_data][unit_amount]': String(amount),
                  'line_items[0][quantity]': '1',
                }),
              });
              if (stripeRes.ok) {
                const stripeData = await stripeRes.json();
                return {
                  tool: 'stripe',
                  action: 'create_payment_link',
                  status: 'executed',
                  message: `✅ Created Stripe payment link for ${productName}`,
                  data: { checkoutUrl: stripeData.url, paymentLinkId: stripeData.id, active: stripeData.active },
                  timestamp,
                };
              }
            }
          } catch (e: any) {
            console.error('[Stripe] API error:', e.message);
          }
        }
        return notConnected('stripe', actionName, timestamp);
      }

      case 'shopify': {
        const shopifyConnId = `${params.orgId}_shopify`;
        const shopifyToken = await getNangoAccessToken(shopifyConnId, 'shopify');
        if (shopifyToken) {
          try {
            const shopDomain = params.payload.shopDomain || process.env.SHOPIFY_SHOP_DOMAIN;
            if (shopDomain) {
              if (actionName.includes('product')) {
                const shopifyRes = await fetch(
                  `https://${shopDomain}/admin/api/2024-01/products.json?limit=10`,
                  { headers: { 'X-Shopify-Access-Token': shopifyToken } }
                );
                if (shopifyRes.ok) {
                  const data = await shopifyRes.json();
                  return {
                    tool: 'shopify',
                    action: 'fetch_products',
                    status: 'executed',
                    message: `Fetched ${data.products?.length || 0} products from Shopify`,
                    data: { products: data.products || [] },
                    timestamp,
                  };
                }
              } else {
                const shopifyRes = await fetch(
                  `https://${shopDomain}/admin/api/2024-01/orders.json?status=open&limit=50`,
                  { headers: { 'X-Shopify-Access-Token': shopifyToken } }
                );
                if (shopifyRes.ok) {
                  const shopifyData = await shopifyRes.json();
                  const orders = shopifyData.orders || [];
                  const totalVolume = orders.reduce((sum: number, o: any) => sum + parseFloat(o.total_price || 0), 0);
                  return {
                    tool: 'shopify',
                    action: 'fetch_orders',
                    status: 'executed',
                    message: `Fetched ${orders.length} live orders from Shopify`,
                    data: { openOrders: orders.length, totalVolume: `$${totalVolume.toFixed(2)}`, orders: orders.slice(0, 5) },
                    timestamp,
                  };
                }
              }
            }
          } catch (e: any) {
            console.error('[Shopify] API error:', e.message);
          }
        }
        return notConnected('shopify', actionName, timestamp);
      }

      case 'zendesk': {
        const zendeskConnId = `${params.orgId}_zendesk`;
        const zendeskToken = await getNangoAccessToken(zendeskConnId, 'zendesk');
        if (zendeskToken) {
          try {
            const subdomain = params.payload.subdomain || process.env.ZENDESK_SUBDOMAIN;
            if (subdomain) {
              if (actionName.includes('update') || actionName.includes('edit')) {
                const ticketId = params.payload.ticketId || params.payload.id;
                if (!ticketId) {
                  return { tool: 'zendesk', action: 'update_ticket', status: 'error', message: 'Ticket id (ticketId) is required to update.', data: null, timestamp };
                }
                const ticket: any = {};
                if (params.payload.status) ticket.status = params.payload.status;
                if (params.payload.priority) ticket.priority = params.payload.priority;
                if (params.payload.subject) ticket.subject = params.payload.subject;
                if (params.payload.assignee_id) ticket.assignee_id = params.payload.assignee_id;
                if (params.payload.comment) ticket.comment = { body: params.payload.comment };
                if (Object.keys(ticket).length === 0) {
                  return { tool: 'zendesk', action: 'update_ticket', status: 'error', message: 'No updatable fields supplied (try status, priority, subject, comment, assignee_id)', data: null, timestamp };
                }
                const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
                  method: 'PUT',
                  headers: { Authorization: `Bearer ${zendeskToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ticket }),
                });
                if (zdRes.ok) {
                  const zdData = await zdRes.json();
                  return {
                    tool: 'zendesk',
                    action: 'update_ticket',
                    status: 'executed',
                    message: `Updated Zendesk ticket #${ticketId}`,
                    data: { ticketId: zdData.ticket?.id, status: zdData.ticket?.status, priority: zdData.ticket?.priority, subject: zdData.ticket?.subject },
                    timestamp,
                  };
                }
                const zdErr = await zdRes.text();
                return { tool: 'zendesk', action: 'update_ticket', status: 'error', message: `Zendesk update failed: ${zdRes.status} ${zdErr.slice(0, 200)}`, data: null, timestamp };
              }
              if (actionName.includes('list') || actionName.includes('fetch')) {
                const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json?sort_by=updated_at&sort_order=desc&per_page=10`, {
                  headers: { Authorization: `Bearer ${zendeskToken}`, Accept: 'application/json' },
                });
                if (zdRes.ok) {
                  const zdData = await zdRes.json();
                  return {
                    tool: 'zendesk',
                    action: 'fetch_tickets',
                    status: 'executed',
                    message: `Fetched ${zdData.tickets?.length || 0} tickets from Zendesk`,
                    data: { tickets: zdData.tickets || [] },
                    timestamp,
                  };
                }
              } else {
                const subject = params.payload.subject || 'Support Request via DareX AI';
                const description = params.payload.description || params.payload.message || 'Customer support request';
                const zdRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${zendeskToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ticket: { subject, comment: { body: description }, priority: params.payload.priority || 'normal' } }),
                });
                if (zdRes.ok) {
                  const zdData = await zdRes.json();
                  return {
                    tool: 'zendesk',
                    action: 'create_support_ticket',
                    status: 'executed',
                    message: `✅ Created Zendesk ticket: ${subject}`,
                    data: { ticketId: zdData.ticket?.id, status: zdData.ticket?.status, subject },
                    timestamp,
                  };
                }
              }
            }
          } catch (e: any) {
            console.error('[Zendesk] API error:', e.message);
          }
        }
        return notConnected('zendesk', actionName, timestamp);
      }

      case 'intercom': {
        const intercomConnId = `${params.orgId}_intercom`;
        const intercomToken = await getNangoAccessToken(intercomConnId, 'intercom');
        if (intercomToken) {
          try {
            const intercomRes = await fetch('https://api.intercom.io/conversations?state=open&per_page=10', {
              headers: { Authorization: `Bearer ${intercomToken}`, Accept: 'application/json', 'Intercom-Version': '2.11' },
            });
            if (intercomRes.ok) {
              const intercomData = await intercomRes.json();
              const conversations = intercomData.conversations || [];
              return {
                tool: 'intercom',
                action: 'fetch_conversations',
                status: 'executed',
                message: `Synced ${conversations.length} live conversations from Intercom`,
                data: { openConversations: conversations.length, conversations: conversations.slice(0, 5) },
                timestamp,
              };
            }
          } catch (e: any) {
            console.error('[Intercom] API error:', e.message);
          }
        }
        return notConnected('intercom', actionName, timestamp);
      }

      case 'razorpay': {
        const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
        if (razorpayKeyId && razorpayKeySecret) {
          try {
            const amount = params.payload.amount || 50000; // paise (₹500)
            const currency = params.payload.currency || 'INR';
            const description = params.payload.description || 'DareX AI Invoice';
            const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
            const rzpRes = await fetch('https://api.razorpay.com/v1/payment_links', {
              method: 'POST',
              headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ amount, currency, description, accept_partial: false }),
            });
            if (rzpRes.ok) {
              const rzpData = await rzpRes.json();
              return {
                tool: 'razorpay',
                action: 'create_invoice',
                status: 'executed',
                message: `✅ Created Razorpay payment link for ₹${(amount / 100).toFixed(2)}`,
                data: { paymentLinkId: rzpData.id, shortUrl: rzpData.short_url, status: rzpData.status },
                timestamp,
              };
            }
          } catch (e: any) {
            console.error('[Razorpay] API error:', e.message);
          }
        }
        return notConnected('razorpay', actionName, timestamp);
      }

      case 'google-drive':
      case 'google-docs':
      case 'google-sheets': {
        const gTool = params.tool.toLowerCase();
        const gConnId = `${params.orgId}_${gTool}`;
        let gToken: string | null = null;
        for (const providerKey of [gTool, 'google']) {
          gToken = await getNangoAccessToken(gConnId, providerKey);
          if (gToken) break;
        }

        if (!gToken) {
          return notConnected(gTool, actionName, timestamp);
        }

        try {
          // ── GOOGLE DRIVE ────────────────────────────────────────────────
          if (gTool === 'google-drive') {
            if (actionName.includes('search') || actionName.includes('find')) {
              const query = params.payload.query || params.payload.name || '';
              const qClause = query
                ? `name contains '${query.replace(/'/g, "\\'")}'`
                : `trashed = false`;
              const driveRes = await fetch(
                `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qClause)}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=${params.payload.maxResults || 25}`,
                { headers: { Authorization: `Bearer ${gToken}` } }
              );
              if (!driveRes.ok) {
                return { tool: 'google-drive', action: 'drive_search', status: 'error', message: `Drive API error ${driveRes.status}: ${await driveRes.text()}`, data: null, timestamp };
              }
              const driveData = await driveRes.json();
              return {
                tool: 'google-drive',
                action: 'drive_search',
                status: 'executed',
                message: `Found ${driveData.files?.length || 0} file${(driveData.files || []).length === 1 ? '' : 's'} in Google Drive`,
                data: { query, files: driveData.files || [] },
                timestamp,
              };
            }

            if (actionName.includes('list')) {
              const folderId = params.payload.folderId || params.payload.parentId || 'root';
              const driveRes = await fetch(
                `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed = false`)}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&pageSize=${params.payload.maxResults || 50}`,
                { headers: { Authorization: `Bearer ${gToken}` } }
              );
              if (!driveRes.ok) {
                return { tool: 'google-drive', action: 'drive_list', status: 'error', message: `Drive API error ${driveRes.status}: ${await driveRes.text()}`, data: null, timestamp };
              }
              const driveData = await driveRes.json();
              return {
                tool: 'google-drive',
                action: 'drive_list',
                status: 'executed',
                message: `Listed ${driveData.files?.length || 0} files under "${folderId}"`,
                data: { folderId, files: driveData.files || [] },
                timestamp,
              };
            }

            if (actionName.includes('share') || actionName.includes('permission')) {
              const fileId = params.payload.fileId || params.payload.id;
              if (!fileId) {
                return { tool: 'google-drive', action: 'drive_share', status: 'error', message: 'fileId is required to share a Drive file.', data: null, timestamp };
              }
              const role = params.payload.role || 'reader';
              const emailAddress = params.payload.email;
              const permBody = emailAddress
                ? { role, type: 'user', emailAddress }
                : { role, type: 'anyone' };
              const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(permBody),
              });
              if (!permRes.ok) {
                return { tool: 'google-drive', action: 'drive_share', status: 'error', message: `Drive share error ${permRes.status}: ${await permRes.text()}`, data: null, timestamp };
              }
              const permData = await permRes.json();
              return {
                tool: 'google-drive',
                action: 'drive_share',
                status: 'executed',
                message: `Shared file ${fileId} with ${emailAddress || 'anyone'} (${role})`,
                data: { fileId, role, emailAddress: emailAddress || 'anyone', permissionId: permData.id },
                timestamp,
              };
            }

            // drive_get_text: export Google-native files or download raw media
            if (actionName.includes('get_text') || actionName.includes('read')) {
              const fileId = params.payload.fileId || params.payload.id;
              if (!fileId) {
                return { tool: 'google-drive', action: 'drive_get_text', status: 'error', message: 'fileId is required to read a Drive file.', data: null, timestamp };
              }
              const mimeType = params.payload.mimeType || '';
              const exportMime = mimeType === 'application/vnd.google-apps.document' ? 'text/plain'
                : mimeType === 'application/vnd.google-apps.spreadsheet' ? 'text/csv'
                : mimeType === 'application/vnd.google-apps.presentation' ? 'text/plain'
                : null;
              const url = exportMime
                ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
                : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
              const contentRes = await fetch(url, { headers: { Authorization: `Bearer ${gToken}` } });
              if (!contentRes.ok) {
                return { tool: 'google-drive', action: 'drive_get_text', status: 'error', message: `Drive read error ${contentRes.status}: ${await contentRes.text()}`, data: null, timestamp };
              }
              const text = (exportMime ? await contentRes.text() : Buffer.from(await contentRes.arrayBuffer()).toString('utf8'));
              return {
                tool: 'google-drive',
                action: 'drive_get_text',
                status: 'executed',
                message: `Extracted ${text.length} characters from Drive file ${fileId}`,
                data: { fileId, mimeType: exportMime || mimeType || 'application/octet-stream', content: text.slice(0, 8000), totalCharacters: text.length },
                timestamp,
              };
            }

            // drive_upload
            if (actionName.includes('upload') || actionName.includes('create_file')) {
              const name = params.payload.name || params.payload.filename || `darex-file-${Date.now()}.txt`;
              const content = params.payload.content || params.payload.text || '';
              const parentId = params.payload.parentId || params.payload.folderId;
              const metadata: any = { name };
              if (parentId) metadata.parents = [parentId];

              const boundary = `drx${Date.now()}`;
              const bodyParts = [
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
                `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
                `--${boundary}--\r\n`,
              ];
              const body = bodyParts.join('');

              const upRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${gToken}`,
                  'Content-Type': `multipart/related; boundary=${boundary}`,
                },
                body,
              });
              if (!upRes.ok) {
                return { tool: 'google-drive', action: 'drive_upload', status: 'error', message: `Drive upload error ${upRes.status}: ${await upRes.text()}`, data: null, timestamp };
              }
              const upData = await upRes.json();
              return {
                tool: 'google-drive',
                action: 'drive_upload',
                status: 'executed',
                message: `Uploaded "${name}" to Google Drive`,
                data: { fileId: upData.id, name, webViewLink: upData.webViewLink || null, size: Buffer.byteLength(content) },
                timestamp,
              };
            }

            return { tool: 'google-drive', action: actionName, status: 'error', message: `Unsupported Drive action "${actionName}". Try drive_search, drive_list, drive_get_text, drive_upload, drive_share.`, data: null, timestamp };
          }

          // ── GOOGLE DOCS ─────────────────────────────────────────────────
          if (gTool === 'google-docs') {
            if (actionName.includes('create')) {
              const title = params.payload.title || params.payload.name || 'Untitled Document';
              const docRes = await fetch('https://docs.googleapis.com/v1/documents', {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
              });
              if (!docRes.ok) {
                return { tool: 'google-docs', action: 'docs_create', status: 'error', message: `Docs create error ${docRes.status}: ${await docRes.text()}`, data: null, timestamp };
              }
              const docData = await docRes.json();
              return {
                tool: 'google-docs',
                action: 'docs_create',
                status: 'executed',
                message: `Created Google Doc "${docData.title}"`,
                data: { documentId: docData.documentId, title: docData.title, url: `https://docs.google.com/document/d/${docData.documentId}/edit` },
                timestamp,
              };
            }

            if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
              const documentId = params.payload.documentId || params.payload.id;
              if (!documentId) {
                return { tool: 'google-docs', action: 'docs_read', status: 'error', message: 'documentId is required to read a Docs document.', data: null, timestamp };
              }
              const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
                headers: { Authorization: `Bearer ${gToken}` },
              });
              if (!docRes.ok) {
                return { tool: 'google-docs', action: 'docs_read', status: 'error', message: `Docs read error ${docRes.status}: ${await docRes.text()}`, data: null, timestamp };
              }
              const docData = await docRes.json();
              const text = (docData.body?.content || [])
                .filter((el: any) => el.paragraph)
                .map((el: any) => (el.paragraph.elements || [])
                  .map((e: any) => e.textRun?.content || '')
                  .join(''))
                .join('\n');
              return {
                tool: 'google-docs',
                action: 'docs_read',
                status: 'executed',
                message: `Read Google Doc "${docData.title}" (${text.length} chars)`,
                data: { documentId, title: docData.title, content: text.slice(0, 8000), totalCharacters: text.length, url: `https://docs.google.com/document/d/${documentId}/edit` },
                timestamp,
              };
            }

            if (actionName.includes('append') || actionName.includes('write')) {
              const documentId = params.payload.documentId || params.payload.id;
              const content = params.payload.content || params.payload.text || '';
              if (!documentId) {
                return { tool: 'google-docs', action: 'docs_append', status: 'error', message: 'documentId is required to append to a Docs document.', data: null, timestamp };
              }
              if (!content) {
                return { tool: 'google-docs', action: 'docs_append', status: 'error', message: 'Content text is required to append.', data: null, timestamp };
              }
              const batched = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requests: [{ insertText: { location: { index: 1 }, text: `${content}\n` } }],
                }),
              });
              if (!batched.ok) {
                return { tool: 'google-docs', action: 'docs_append', status: 'error', message: `Docs append error ${batched.status}: ${await batched.text()}`, data: null, timestamp };
              }
              return {
                tool: 'google-docs',
                action: 'docs_append',
                status: 'executed',
                message: `Appended ${content.length} characters to Google Doc ${documentId}`,
                data: { documentId, appendedCharacters: content.length + 1 },
                timestamp,
              };
            }

            return { tool: 'google-docs', action: actionName, status: 'error', message: `Unsupported Docs action "${actionName}". Try docs_create, docs_read, docs_append.`, data: null, timestamp };
          }

          // ── GOOGLE SHEETS ───────────────────────────────────────────────
          if (gTool === 'google-sheets') {
            if (actionName.includes('create')) {
              const title = params.payload.title || params.payload.name || 'Untitled Spreadsheet';
              const sheetRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ properties: { title } }),
              });
              if (!sheetRes.ok) {
                return { tool: 'google-sheets', action: 'sheets_create', status: 'error', message: `Sheets create error ${sheetRes.status}: ${await sheetRes.text()}`, data: null, timestamp };
              }
              const sheetData = await sheetRes.json();
              return {
                tool: 'google-sheets',
                action: 'sheets_create',
                status: 'executed',
                message: `Created Google Sheet "${sheetData.properties?.title}"`,
                data: { spreadsheetId: sheetData.spreadsheetId, title: sheetData.properties?.title, url: sheetData.spreadsheetUrl },
                timestamp,
              };
            }

            const spreadsheetId = params.payload.spreadsheetId || params.payload.id || params.payload.sheetId;
            if (!spreadsheetId) {
              return { tool: 'google-sheets', action: actionName, status: 'error', message: 'spreadsheetId is required for Sheets actions.', data: null, timestamp };
            }
            const range = params.payload.range || 'Sheet1!A1:Z500';

            if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
              const valRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
                headers: { Authorization: `Bearer ${gToken}` },
              });
              if (!valRes.ok) {
                return { tool: 'google-sheets', action: 'sheets_read', status: 'error', message: `Sheets read error ${valRes.status}: ${await valRes.text()}`, data: null, timestamp };
              }
              const valData = await valRes.json();
              return {
                tool: 'google-sheets',
                action: 'sheets_read',
                status: 'executed',
                message: `Read ${valData.values?.length || 0} rows from ${range}`,
                data: { spreadsheetId, range, rows: valData.values || [] },
                timestamp,
              };
            }

            if (actionName.includes('append') || actionName.includes('add_row') || actionName.includes('insert')) {
              const rawValues = params.payload.values || params.payload.rows;
              const row = params.payload.row;
              let values: any[][];
              if (Array.isArray(rawValues)) {
                values = rawValues.length && Array.isArray(rawValues[0]) ? rawValues : [rawValues];
              } else if (Array.isArray(row)) {
                values = [row];
              } else {
                values = [[params.payload.value ?? params.payload.content ?? '']];
              }

              if (!values.length || !values[0].length) {
                return { tool: 'google-sheets', action: 'sheets_append_row', status: 'error', message: 'Provide values (array) or row array to append data.', data: null, timestamp };
              }

              const appendRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ values }),
              });
              if (!appendRes.ok) {
                return { tool: 'google-sheets', action: 'sheets_append_row', status: 'error', message: `Sheets append error ${appendRes.status}: ${await appendRes.text()}`, data: null, timestamp };
              }
              const appendData = await appendRes.json();
              return {
                tool: 'google-sheets',
                action: 'sheets_append_row',
                status: 'executed',
                message: `Appended ${appendData.updates?.updatedRows || values.length} row(s) to ${range}`,
                data: { spreadsheetId, range, updatedRange: appendData.updates?.updatedRange, values: values.slice(0, 10) },
                timestamp,
              };
            }

            return { tool: 'google-sheets', action: actionName, status: 'error', message: `Unsupported Sheets action "${actionName}". Try sheets_create, sheets_read, sheets_append_row.`, data: null, timestamp };
          }

          return {
            tool: gTool,
            action: actionName,
            status: 'error',
            message: `Unhandled Google tool "${gTool}"`,
            data: null,
            timestamp,
          };
        } catch (e: any) {
          console.error(`[${gTool}] API error:`, e.message);
          return {
            tool: gTool,
            action: actionName,
            status: 'error',
            message: `${gTool} request failed: ${e.message}`,
            data: null,
            timestamp,
          };
        }
      }

      default: {
        return {
          tool: params.tool,
          action: params.action,
          status: 'error',
          message: `Unknown tool "${params.tool}" — no executor registered for this tool.`,
          data: null,
          timestamp,
        };
      }
    }
  } catch (error: any) {
    return {
      tool: params.tool,
      action: params.action,
      status: 'error',
      message: error.message || 'Tool execution error',
      data: null,
      timestamp,
    };
  }
}
