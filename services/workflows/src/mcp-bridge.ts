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
