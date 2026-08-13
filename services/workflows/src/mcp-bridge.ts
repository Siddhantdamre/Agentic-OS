import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { executeAutonomousToolAction } from './tool-executor.js';

const PORT = parseInt(process.env.ATOMIC_BRIDGE_PORT || '8790', 10);
const SSE_ENDPOINT = '/sse';
const MESSAGE_ENDPOINT = '/messages';

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  tool: string;
  action: string;
}

const TOOLS: ToolDef[] = [
  {
    name: 'whatsapp_send',
    description:
      'Send a WhatsApp text message to a phone number via the org-connected WhatsApp Business channel. Requires org_id.',
    schema: { org_id: z.string(), phone: z.string(), message: z.string() },
    tool: 'whatsapp',
    action: 'send_whatsapp_message',
  },
  {
    name: 'gmail_fetch',
    description: 'Fetch the latest emails from the org-connected Gmail inbox.',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'gmail',
    action: 'fetch_latest_emails',
  },
  {
    name: 'gmail_send',
    description: 'Send an email from the org-connected Gmail account.',
    schema: {
      org_id: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    },
    tool: 'gmail',
    action: 'send_email',
  },
  {
    name: 'gmail_triage',
    description:
      'Fetch and categorize the latest emails (urgent, billing, security, customer-support, newsletter, automated, general).',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'gmail',
    action: 'triage_emails',
  },
  {
    name: 'gmail_extract_otp',
    description:
      'Scan the latest emails for OTP / verification codes and return the detected codes with surrounding context.',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'gmail',
    action: 'extract_otp',
  },
  {
    name: 'gmail_extract_attachment',
    description:
      'Find an attachment in recent email and extract its text content (PDF or text files supported).',
    schema: {
      org_id: z.string(),
      count: z.number().optional(),
      subject: z.string().optional(),
      filename: z.string().optional(),
    },
    tool: 'gmail',
    action: 'extract_attachment',
  },
  {
    name: 'gmail_draft_email',
    description:
      'Create a Gmail draft (does NOT send) for the org-connected account. User reviews it before sending.',
    schema: {
      org_id: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
    },
    tool: 'gmail',
    action: 'draft_email',
  },
  {
    name: 'calendar_list_events',
    description:
      'List upcoming events (next 7 days) from the org-connected Google Calendar.',
    schema: { org_id: z.string() },
    tool: 'google-calendar',
    action: 'list_events',
  },
  {
    name: 'calendar_create_event',
    description:
      'Create a Google Calendar event with optional Google Meet link from the org-connected account.',
    schema: {
      org_id: z.string(),
      summary: z.string(),
      startTime: z.string(),
      endTime: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      timeZone: z.string().optional(),
      attendees: z.array(z.string()).optional(),
    },
    tool: 'google-calendar',
    action: 'create_event',
  },
  {
    name: 'calendar_check_availability',
    description:
      'Find free time slots for a given duration across a date window on the org-connected Google Calendar.',
    schema: {
      org_id: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      durationMinutes: z.number().optional(),
      dayStart: z.string().optional(),
      dayEnd: z.string().optional(),
    },
    tool: 'google-calendar',
    action: 'check_availability',
  },
  {
    name: 'github_fetch_repos',
    description: 'Fetch the org-connected GitHub account repositories.',
    schema: { org_id: z.string() },
    tool: 'github',
    action: 'fetch_user_repos',
  },
  {
    name: 'github_create_repo',
    description: 'Create a repository on the org-connected GitHub account.',
    schema: { org_id: z.string(), name: z.string(), private: z.boolean().optional() },
    tool: 'github',
    action: 'create_repo',
  },
  {
    name: 'github_create_issue',
    description: 'Create an issue on a repository of the org-connected GitHub account (repo as "owner/name" or just "name").',
    schema: {
      org_id: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
    },
    tool: 'github',
    action: 'create_issue',
  },
  {
    name: 'hubspot_create_contact',
    description: 'Create a contact in the org-connected HubSpot CRM.',
    schema: {
      org_id: z.string(),
      email: z.string(),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
    },
    tool: 'hubspot',
    action: 'create_crm_contact',
  },
  {
    name: 'hubspot_update_contact',
    description:
      'Update an existing HubSpot contact by email (firstname, lastname, phone, jobtitle, lifecyclestage, company, etc.).',
    schema: {
      org_id: z.string(),
      email: z.string(),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      phone: z.string().optional(),
      jobtitle: z.string().optional(),
      lifecyclestage: z.string().optional(),
      company: z.string().optional(),
    },
    tool: 'hubspot',
    action: 'update_contact',
  },
  {
    name: 'meta_ads_metrics',
    description:
      'Fetch Meta Ads campaign metrics (last 7 days) for the org-connected ad account.',
    schema: { org_id: z.string(), adAccountId: z.string().optional() },
    tool: 'meta-ads',
    action: 'fetch_campaign_metrics',
  },
  {
    name: 'google_ads_metrics',
    description:
      'Fetch Google Ads campaign metrics (last 7 days) for the org-connected customer.',
    schema: { org_id: z.string(), customerId: z.string().optional() },
    tool: 'google-ads',
    action: 'fetch_campaign_metrics',
  },
  {
    name: 'slack_send',
    description: 'Send a message to a Slack channel via the org-connected Slack workspace.',
    schema: { org_id: z.string(), channel: z.string().optional(), message: z.string() },
    tool: 'slack',
    action: 'send_channel_message',
  },
  {
    name: 'notion_create_page',
    description: 'Create a page in the org-connected Notion workspace.',
    schema: { org_id: z.string(), title: z.string(), parentPageId: z.string().optional() },
    tool: 'notion',
    action: 'create_page',
  },
  {
    name: 'notion_append_page_content',
    description: 'Append paragraph blocks of content to an existing page in the org-connected Notion workspace.',
    schema: { org_id: z.string(), pageId: z.string(), content: z.string() },
    tool: 'notion',
    action: 'append_page_content',
  },
  {
    name: 'notion_search',
    description: 'Search documents in the org-connected Notion workspace.',
    schema: { org_id: z.string(), query: z.string().optional() },
    tool: 'notion',
    action: 'search_workspace_docs',
  },
  {
    name: 'stripe_create_payment_link',
    description: 'Create a Stripe payment link for the org-connected Stripe account.',
    schema: {
      org_id: z.string(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      name: z.string().optional(),
    },
    tool: 'stripe',
    action: 'create_payment_link',
  },
  {
    name: 'shopify_fetch_products',
    description: 'Fetch products from the org-connected Shopify store.',
    schema: { org_id: z.string() },
    tool: 'shopify',
    action: 'fetch_products',
  },
  {
    name: 'shopify_fetch_orders',
    description: 'Fetch open orders from the org-connected Shopify store.',
    schema: { org_id: z.string() },
    tool: 'shopify',
    action: 'fetch_orders',
  },
  {
    name: 'zendesk_fetch_tickets',
    description: 'Fetch recent tickets from the org-connected Zendesk.',
    schema: { org_id: z.string() },
    tool: 'zendesk',
    action: 'fetch_tickets',
  },
  {
    name: 'zendesk_create_ticket',
    description: 'Create a support ticket in the org-connected Zendesk.',
    schema: {
      org_id: z.string(),
      subject: z.string().optional(),
      description: z.string().optional(),
      priority: z.string().optional(),
    },
    tool: 'zendesk',
    action: 'create_support_ticket',
  },
  {
    name: 'zendesk_update_ticket',
    description: 'Update an existing Zendesk ticket (status, priority, subject, comment, assignee_id).',
    schema: {
      org_id: z.string(),
      ticketId: z.string(),
      status: z.string().optional(),
      priority: z.string().optional(),
      subject: z.string().optional(),
      comment: z.string().optional(),
      assignee_id: z.number().optional(),
    },
    tool: 'zendesk',
    action: 'update_ticket',
  },
  {
    name: 'intercom_fetch_conversations',
    description: 'Fetch open conversations from the org-connected Intercom.',
    schema: { org_id: z.string() },
    tool: 'intercom',
    action: 'fetch_conversations',
  },
  {
    name: 'razorpay_create_payment_link',
    description: 'Create a Razorpay payment link (amount in paise).',
    schema: {
      org_id: z.string(),
      amount: z.number().optional(),
      currency: z.string().optional(),
      description: z.string().optional(),
    },
    tool: 'razorpay',
    action: 'create_payment_link',
  },
  {
    name: 'web_search',
    description: 'Perform a live web search (DuckDuckGo) for a query.',
    schema: { org_id: z.string(), query: z.string() },
    tool: 'web_search',
    action: 'search',
  },
  {
    name: 'web_extract',
    description: 'Extract clean text content from a web page URL.',
    schema: { org_id: z.string(), url: z.string() },
    tool: 'web_extract',
    action: 'extract',
  },
  {
    name: 'database_query',
    description:
      'Run a read-only SELECT query against the org-scoped business database (RLS enforced). Returns up to 25 rows.',
    schema: { org_id: z.string(), sql: z.string() },
    tool: 'database_query',
    action: 'query',
  },
  {
    name: 'file_ops',
    description:
      'Read or write a text file in the org workspace storage area.',
    schema: {
      org_id: z.string(),
      action: z.enum(['read_file', 'write_file']),
      path: z.string().optional(),
      content: z.string().optional(),
    },
    tool: 'file_ops',
    action: 'auto_execute',
  },
  {
    name: 'drive_search',
    description:
      'Search files in the org-connected Google Drive by name. Returns id, name, mimeType, size, webViewLink.',
    schema: { org_id: z.string(), query: z.string().optional(), maxResults: z.number().optional() },
    tool: 'google-drive',
    action: 'drive_search',
  },
  {
    name: 'drive_list',
    description: 'List files inside a folder of the org-connected Google Drive.',
    schema: { org_id: z.string(), folderId: z.string().optional(), maxResults: z.number().optional() },
    tool: 'google-drive',
    action: 'drive_list',
  },
  {
    name: 'drive_get_text',
    description:
      'Extract text content from a file in the org-connected Google Drive (exports Docs/Sheets, downloads raw media).',
    schema: { org_id: z.string(), fileId: z.string(), mimeType: z.string().optional() },
    tool: 'google-drive',
    action: 'drive_get_text',
  },
  {
    name: 'drive_upload',
    description: 'Upload a text file to the org-connected Google Drive (optionally into a folder).',
    schema: { org_id: z.string(), name: z.string().optional(), content: z.string().optional(), parentId: z.string().optional() },
    tool: 'google-drive',
    action: 'drive_upload',
  },
  {
    name: 'drive_share',
    description: 'Share a file in the org-connected Google Drive with a user email or publicly.',
    schema: { org_id: z.string(), fileId: z.string(), role: z.string().optional(), email: z.string().optional() },
    tool: 'google-drive',
    action: 'drive_share',
  },
  {
    name: 'docs_create',
    description: 'Create a new Google Docs document in the org-connected account.',
    schema: { org_id: z.string(), title: z.string().optional() },
    tool: 'google-docs',
    action: 'docs_create',
  },
  {
    name: 'docs_read',
    description: 'Read the full text content of an org-connected Google Docs document.',
    schema: { org_id: z.string(), documentId: z.string() },
    tool: 'google-docs',
    action: 'docs_read',
  },
  {
    name: 'docs_append',
    description: 'Append text content to an org-connected Google Docs document.',
    schema: { org_id: z.string(), documentId: z.string(), content: z.string() },
    tool: 'google-docs',
    action: 'docs_append',
  },
  {
    name: 'sheets_create',
    description: 'Create a new Google Sheets spreadsheet in the org-connected account.',
    schema: { org_id: z.string(), title: z.string().optional() },
    tool: 'google-sheets',
    action: 'sheets_create',
  },
  {
    name: 'sheets_read',
    description: 'Read rows from a range in an org-connected Google Sheets spreadsheet.',
    schema: { org_id: z.string(), spreadsheetId: z.string(), range: z.string().optional() },
    tool: 'google-sheets',
    action: 'sheets_read',
  },
  {
    name: 'sheets_append_row',
    description: 'Append one or more rows to an org-connected Google Sheets spreadsheet.',
    schema: {
      org_id: z.string(),
      spreadsheetId: z.string(),
      range: z.string().optional(),
      values: z.array(z.any()).optional(),
      row: z.array(z.any()).optional(),
      value: z.string().optional(),
    },
    tool: 'google-sheets',
    action: 'sheets_append_row',
  },
  {
    name: 'slides_create',
    description: 'Create a new Google Slides presentation in the org-connected account.',
    schema: { org_id: z.string(), title: z.string().optional() },
    tool: 'google-slides',
    action: 'slides_create',
  },
  {
    name: 'forms_get',
    description: 'Get details and responses from a Google Form in the org-connected account.',
    schema: { org_id: z.string(), formId: z.string() },
    tool: 'google-forms',
    action: 'forms_get',
  },
  {
    name: 'contacts_list',
    description: 'List connections and contacts from the org-connected Google Contacts account.',
    schema: { org_id: z.string(), pageSize: z.number().optional() },
    tool: 'google-contacts',
    action: 'contacts_list',
  },
  {
    name: 'tasks_list',
    description: 'Fetch task lists and tasks from the org-connected Google Tasks account.',
    schema: { org_id: z.string(), tasklistId: z.string().optional() },
    tool: 'google-tasks',
    action: 'tasks_list',
  },
  {
    name: 'analytics_report',
    description: 'Run a report query against the org-connected Google Analytics property.',
    schema: { org_id: z.string(), propertyId: z.string() },
    tool: 'google-analytics',
    action: 'analytics_report',
  },
];

function createServer(): McpServer {
  const server = new McpServer({
    name: 'darex-connectors',
    version: '0.1.0',
  });

  for (const toolDef of TOOLS) {
    const { name, description, schema, tool, action } = toolDef;
    server.registerTool(name, {
      description,
      inputSchema: schema as any,
    }, async (args: any) => {
      const orgId = String(args.org_id || '');
      const payload: Record<string, any> = { ...args };
      delete payload.org_id;

      // The bridge is localhost-only, but still validate the org id before any
      // side-effect: reject missing / malformed org ids instead of passing a
      // garbage value downstream.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(orgId)) {
        return textContent(JSON.stringify({
          status: 'error',
          message: 'A valid org_id (UUID) is required for this tool call.',
          data: null,
        }, null, 2));
      }

      // file_ops uses the tool-level action field for read/write.
      if (tool === 'file_ops') {
        const fileAction = String(args.action || 'read_file');
        delete payload.action;
        const result = await executeAutonomousToolAction({
          tool,
          action: fileAction,
          payload,
          orgId,
        });
        return textContent(formatResult(result));
      }

      const result = await executeAutonomousToolAction({
        tool,
        action,
        payload,
        orgId,
      });
      return textContent(formatResult(result));
    });
  }

  return server;
}

function formatResult(result: any): string {
  return JSON.stringify(
    {
      status: result?.status,
      message: result?.message,
      data: result?.data ?? null,
    },
    null,
    2
  );
}

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

const transports: Record<string, SSEServerTransport> = {};

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === SSE_ENDPOINT) {
    const transport = new SSEServerTransport(MESSAGE_ENDPOINT, res);
    transports[transport.sessionId] = transport;
    res.on('close', () => {
      delete transports[transport.sessionId];
    });
    // One McpServer per connection: the SDK prohibits reconnecting a
    // Protocol instance once it is bound to a transport.
    const server = createServer();
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST' && url.pathname === MESSAGE_ENDPOINT) {
    const sessionId = url.searchParams.get('sessionId');
    const transport = sessionId ? transports[sessionId] : undefined;
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No active SSE session. Connect to /sse first.');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[atomic-bridge] MCP SSE server listening on http://0.0.0.0:${PORT}${SSE_ENDPOINT} (${TOOLS.length} tools exposed)`
  );
});

process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
