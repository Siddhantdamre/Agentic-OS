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
        if (actionName.includes('fetch') || actionName.includes('read') || actionName.includes('list')) {
          const count = params.payload.count || 10;
          const connId = `${params.orgId}_gmail`;
          const accessToken = await getNangoAccessToken(connId, 'gmail');

          if (accessToken) {
            console.log(`[Gmail Tool] Fetching real live emails using OAuth access token for connection ${connId}...`);
            const realEmails = await fetchRealGmailMessages(accessToken, count);

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

        // Try both common Nango provider key names for Gmail
        const gmailConnId = `${params.orgId}_gmail`;
        let gmailToken: string | null = null;
        for (const providerKey of ['gmail', 'google-mail', 'google']) {
          gmailToken = await getNangoAccessToken(gmailConnId, providerKey);
          if (gmailToken) break;
        }
        const accessToken = gmailToken;

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
        const firstname = params.payload.firstname || '';
        const lastname = params.payload.lastname || '';

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
                properties: { email: contactEmail, firstname, lastname, lifecyclestage: 'lead' },
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
                  firstname,
                  lastname,
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
        const metaAdsToken = await getNangoAccessToken(metaAdsConnId, 'facebook-ads');
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
