import http from 'http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { executeAutonomousToolAction, resolveToolRisk } from './tool-executor.js';
import { dbPool } from './tools/shared.js';
import { formatResult } from './mcp-bridge-format.js';

const PORT_RAW = parseInt(process.env.MCP_BRIDGE_PORT || process.env.ATOMIC_BRIDGE_PORT || '8790', 10);
const PORT = Number.isFinite(PORT_RAW) && PORT_RAW > 0 ? PORT_RAW : 8790;
const SSE_ENDPOINT = '/sse';
const MESSAGE_ENDPOINT = '/messages';

// Tenant header auth: dashboard/worker sign x-tfg-mcp-headers with
// MCP_BRIDGE_SECRET (see buildMcpTenantHeaders in trueforge-client.ts).
// Secret set → unsigned/invalid traffic is rejected. Secret unset → dev-only
// unsigned mode; production refuses to serve without a secret.
const BRIDGE_SECRET = process.env.MCP_BRIDGE_SECRET;
const TENANT_TS_SKEW_MS = parseInt(process.env.MCP_BRIDGE_TS_SKEW_MS || '3600000', 10);
const MAX_SESSIONS = 200;
/** Per-org cap so one tenant can't starve the global pool. LRU-evicts oldest of that org. */
const MAX_SESSIONS_PER_ORG = parseInt(process.env.MCP_BRIDGE_MAX_SESSIONS_PER_ORG || '20', 10);
const SESSION_IDLE_MS = 10 * 60 * 1000;

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  tool: string;
  action: string;
  risk?: string;
  confirm?: boolean;
}

const TOOLS: ToolDef[] = [
  {
    name: 'whatsapp_send',
    description:
      'Send a WhatsApp text message to a phone number via the org-connected WhatsApp Business channel.',
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
    name: 'hubspot_list_deals',
    description: 'List deals from the org-connected HubSpot CRM. Returns notConnected when HubSpot is unsigned.',
    schema: { org_id: z.string(), limit: z.number().optional() },
    tool: 'hubspot',
    action: 'list_deals',
  },
  {
    name: 'hubspot_create_deal',
    description:
      'Create a deal in the org-connected HubSpot CRM. Returns the real HubSpot deal id; never invents ids. notConnected when unsigned.',
    schema: {
      org_id: z.string(),
      dealname: z.string().optional(),
      name: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      dealstage: z.string().optional(),
      stage: z.string().optional(),
      pipeline: z.string().optional(),
      closedate: z.string().optional(),
    },
    tool: 'hubspot',
    action: 'create_deal',
  },
  {
    name: 'hubspot_update_deal',
    description:
      'Update a HubSpot deal by real dealId from list_deals/create_deal. Never invent deal ids. notConnected when unsigned.',
    schema: {
      org_id: z.string(),
      dealId: z.string().optional(),
      deal_id: z.string().optional(),
      id: z.string().optional(),
      dealname: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      dealstage: z.string().optional(),
      stage: z.string().optional(),
      pipeline: z.string().optional(),
      closedate: z.string().optional(),
    },
    tool: 'hubspot',
    action: 'update_deal',
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
    schema: { org_id: z.string(), channel: z.string().optional(), message: z.string(), employee_role: z.string().optional() },
    tool: 'slack',
    action: 'send_channel_message',
  },
  {
    name: 'slack_read_channel',
    description: 'Read recent messages from a Slack channel in the org-connected workspace.',
    schema: { org_id: z.string(), channel: z.string().optional(), employee_role: z.string().optional() },
    tool: 'slack',
    action: 'read_channel',
  },
  {
    name: 'slack_post_decision_card',
    description: 'Post a Slack Block Kit Approve/Reject card for a work item.',
    schema: {
      org_id: z.string(),
      channel: z.string().optional(),
      workItemId: z.string(),
      title: z.string().optional(),
      message: z.string().optional(),
      employee_role: z.string().optional(),
    },
    tool: 'slack',
    action: 'post_decision_card',
  },
  {
    name: 'linkedin_search_people',
    description: 'Search LinkedIn people. Returns notConnected when the org has no LinkedIn connector.',
    schema: { org_id: z.string(), query: z.string().optional(), keywords: z.string().optional(), employee_role: z.string().optional() },
    tool: 'linkedin',
    action: 'search_people',
  },
  {
    name: 'linkedin_company_signals',
    description: 'Fetch LinkedIn organization signals. Honest notConnected when unconfigured.',
    schema: { org_id: z.string(), company: z.string().optional(), employee_role: z.string().optional() },
    tool: 'linkedin',
    action: 'company_signals',
  },
  {
    name: 'apollo_search_people',
    description: 'Search Apollo people. Returns notConnected when Apollo is not connected.',
    schema: { org_id: z.string(), query: z.string().optional(), name: z.string().optional(), employee_role: z.string().optional() },
    tool: 'apollo',
    action: 'search_people',
  },
  {
    name: 'apollo_enrich_company',
    description: 'Enrich a company via Apollo. Honest notConnected when unconfigured.',
    schema: { org_id: z.string(), domain: z.string().optional(), company: z.string().optional(), employee_role: z.string().optional() },
    tool: 'apollo',
    action: 'enrich_company',
  },
  {
    name: 'notion_create_page',
    description: 'Create a page in the org-connected Notion workspace.',
    schema: { org_id: z.string(), title: z.string(), parentPageId: z.string().optional(), content: z.string().optional() },
    tool: 'notion',
    action: 'create_page',
  },
  {
    name: 'notion_read_page',
    description: 'Read page content, properties, and markdown text from an existing page in the org-connected Notion workspace.',
    schema: { org_id: z.string(), pageId: z.string() },
    tool: 'notion',
    action: 'read_page',
  },
  {
    name: 'notion_append_page_content',
    description: 'Append paragraph blocks of content to an existing page in the org-connected Notion workspace.',
    schema: { org_id: z.string(), pageId: z.string(), content: z.string() },
    tool: 'notion',
    action: 'append_page_content',
  },
  {
    name: 'notion_query_database',
    description: 'Query records and properties from a database in the org-connected Notion workspace.',
    schema: { org_id: z.string(), databaseId: z.string(), pageSize: z.number().optional() },
    tool: 'notion',
    action: 'query_database',
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
    description: 'Create a Stripe payment link for the org-connected Stripe account. Confirm class pay — never auto-charge.',
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
    name: 'stripe_create_charge',
    description:
      'Create a Stripe charge / PaymentIntent for the org-connected account. ALWAYS requires human approval before any charge is created. Never auto-charges.',
    schema: {
      org_id: z.string(),
      amount: z.number(),
      currency: z.string().optional(),
      customerId: z.string().optional(),
      paymentMethodId: z.string().optional(),
      description: z.string().optional(),
    },
    tool: 'stripe',
    action: 'create_charge',
  },
  {
    name: 'billing_usage',
    description:
      'Read this organization\'s Darex billing usage (meters + subscription) from billing tables under RLS. Never invents usage numbers; honest error if tables are missing.',
    schema: { org_id: z.string() },
    tool: 'billing',
    action: 'billing_usage',
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
    description: 'Search the live web. Use this first for public facts, companies, people, founders, news, and products. Pass a short query. Then write the answer from the titles and snippets.',
    schema: { org_id: z.string(), query: z.string() },
    tool: 'web_search',
    action: 'search',
  },
  {
    name: 'web_extract',
    description: 'Read one public web page. Use this after web_search when the snippets do not answer the question. Pass the best result URL.',
    schema: { org_id: z.string(), url: z.string() },
    tool: 'web_extract',
    action: 'extract',
  },
  {
    name: 'database_query',
    description:
      'Run a read-only SELECT query against the org-scoped business database (RLS enforced). Returns up to 25 rows. Prefer metrics.query for KPIs such as Unworked inquiries.',
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
      'Search files and folders in the org-connected Google Drive. Supports filtering by name, type ("folder", "colab", "doc", "sheet", "presentation"), and searching inside specific folders. Returns id, name, mimeType, size, webViewLink, and categorized folders/files.',
    schema: {
      org_id: z.string(),
      query: z.string().optional(),
      type: z.enum(['folder', 'colab', 'notebook', 'doc', 'sheet', 'presentation', 'all']).optional(),
      folderId: z.string().optional(),
      maxResults: z.number().optional(),
    },
    tool: 'google-drive',
    action: 'drive_search',
  },
  {
    name: 'drive_list',
    description:
      'List files and folders inside a folder of the org-connected Google Drive (or list all folders in the drive). folderId can be "root", a folder name (e.g. "Colab Notebooks", "final_dataset"), a folder URL, or a folder ID. Setting foldersOnly: true returns all folders.',
    schema: {
      org_id: z.string(),
      folderId: z.string().optional(),
      foldersOnly: z.boolean().optional(),
      type: z.enum(['folder', 'file', 'all']).optional(),
      maxResults: z.number().optional(),
    },
    tool: 'google-drive',
    action: 'drive_list',
  },
  {
    name: 'drive_create_folder',
    description: 'Create a new folder in the org-connected Google Drive under root or a parent folder.',
    schema: {
      org_id: z.string(),
      name: z.string(),
      parentId: z.string().optional(),
    },
    tool: 'google-drive',
    action: 'drive_create_folder',
  },
  {
    name: 'drive_get_text',
    description:
      'Extract text content from a file in the org-connected Google Drive (exports Docs/Sheets/Slides, extracts Jupyter/Colab .ipynb notebook cells, lists folders).',
    schema: { org_id: z.string(), fileId: z.string(), mimeType: z.string().optional() },
    tool: 'google-drive',
    action: 'drive_get_text',
  },
  {
    name: 'drive_upload',
    description: 'Upload a text file to the org-connected Google Drive (optionally into a folder by name, ID, or URL).',
    schema: { org_id: z.string(), name: z.string().optional(), content: z.string().optional(), parentId: z.string().optional() },
    tool: 'google-drive',
    action: 'drive_upload',
  },
  {
    name: 'drive_share',
    description: 'Share a file or folder in the org-connected Google Drive with a user email or publicly.',
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
    description: 'Create a new Google Slides presentation with optional slides content in the org-connected account. Pass the full array of slides with title and body to populate the presentation in one shot. Returns edit URL.',
    schema: {
      org_id: z.string(),
      title: z.string().optional(),
      slides: z.array(z.object({
        title: z.string().optional(),
        body: z.union([z.string(), z.array(z.string())]).optional(),
        content: z.union([z.string(), z.array(z.string())]).optional(),
      })).optional(),
      deleteExisting: z.boolean().optional(),
    },
    tool: 'google-slides',
    action: 'slides_create',
  },
  {
    name: 'slides_add_slide',
    description: 'Add one or more new slides with title and content to an existing Google Slides presentation.',
    schema: {
      org_id: z.string(),
      presentationId: z.string(),
      title: z.string().optional(),
      body: z.union([z.string(), z.array(z.string())]).optional(),
      content: z.union([z.string(), z.array(z.string())]).optional(),
      slides: z.array(z.object({
        title: z.string().optional(),
        body: z.union([z.string(), z.array(z.string())]).optional(),
      })).optional(),
    },
    tool: 'google-slides',
    action: 'slides_add_slide',
  },
  {
    name: 'slides_update_slide',
    description: 'Update or set the title and body content on existing slide(s) in a Google Slides presentation by slideIndex (0-indexed) or slideId, or update multiple slides in batch.',
    schema: {
      org_id: z.string(),
      presentationId: z.string(),
      slideIndex: z.number().optional(),
      slideId: z.string().optional(),
      title: z.string().optional(),
      body: z.union([z.string(), z.array(z.string())]).optional(),
      content: z.union([z.string(), z.array(z.string())]).optional(),
      slides: z.array(z.object({
        slideIndex: z.number().optional(),
        slideId: z.string().optional(),
        title: z.string().optional(),
        body: z.union([z.string(), z.array(z.string())]).optional(),
        content: z.union([z.string(), z.array(z.string())]).optional(),
      })).optional(),
    },
    tool: 'google-slides',
    action: 'slides_update_slide',
  },
  {
    name: 'slides_get',
    description: 'Fetch presentation details, slide count, and list of slides with their titles/text from a Google Slides presentation.',
    schema: {
      org_id: z.string(),
      presentationId: z.string(),
    },
    tool: 'google-slides',
    action: 'slides_get',
  },
  {
    name: 'slides_delete_slide',
    description: 'Delete a slide from an existing Google Slides presentation by slideId or slideIndex.',
    schema: {
      org_id: z.string(),
      presentationId: z.string(),
      slideId: z.string().optional(),
      slideIndex: z.number().optional(),
    },
    tool: 'google-slides',
    action: 'slides_delete_slide',
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
    name: 'code_execution',
    description: 'Run python, node, or bash in the isolated Darex sandbox (no network, no DB).',
    schema: {
      org_id: z.string(),
      language: z.string().optional(),
      code: z.string(),
      timeoutMs: z.number().optional(),
    },
    tool: 'code_execution',
    action: 'execute',
  },
  {
    name: 'terminal_run_command',
    description: 'Execute shell and bash commands in the isolated terminal sandbox (e.g. bash, curl, jq, bc, grep, awk, sed, file creation). Use for command-line operations, text processing, and system tasks.',
    schema: {
      org_id: z.string(),
      command: z.string(),
      timeoutMs: z.number().optional(),
    },
    tool: 'terminal_run_command',
    action: 'terminal_run_command',
  },
  {
    name: 'python_execute',
    description: 'Execute Python 3 scripts in the isolated sandbox. Use for heavy data analysis, algorithmic calculations, statistics, math, string parsing, and verification.',
    schema: {
      org_id: z.string(),
      code: z.string(),
      timeoutMs: z.number().optional(),
    },
    tool: 'python_execute',
    action: 'python_execute',
  },
  {
    name: 'stripe_create_customer',
    description: 'Create a Stripe customer on the org-connected Stripe account.',
    schema: { org_id: z.string(), email: z.string(), name: z.string().optional() },
    tool: 'stripe',
    action: 'create_customer',
  },
  {
    name: 'stripe_get_customer',
    description: 'Get a Stripe customer by id or email from the org-connected Stripe account.',
    schema: { org_id: z.string(), customerId: z.string().optional(), email: z.string().optional() },
    tool: 'stripe',
    action: 'get_customer',
  },
  {
    name: 'intercom_reply',
    description: 'Reply to an Intercom conversation as the connected admin.',
    schema: {
      org_id: z.string(),
      conversationId: z.string(),
      body: z.string(),
      adminId: z.string().optional(),
    },
    tool: 'intercom',
    action: 'reply_conversation',
  },
  {
    name: 'intercom_create_conversation',
    description: 'Create an Intercom conversation from a user/contact or admin.',
    schema: {
      org_id: z.string(),
      body: z.string(),
      userId: z.string().optional(),
      adminId: z.string().optional(),
    },
    tool: 'intercom',
    action: 'create_conversation',
  },
  {
    name: 'chat_list_spaces',
    description: 'List Google Chat spaces for the org-connected Google Chat account.',
    schema: { org_id: z.string() },
    tool: 'google-chat',
    action: 'chat_list_spaces',
  },
  {
    name: 'chat_send_message',
    description: 'Send a text message to a Google Chat space (spaces/xxx).',
    schema: { org_id: z.string(), space: z.string(), text: z.string() },
    tool: 'google-chat',
    action: 'chat_send_message',
  },
  {
    name: 'meet_create_space',
    description: 'Create a Google Meet space and return the meeting URI.',
    schema: { org_id: z.string() },
    tool: 'google-meet',
    action: 'meet_create_space',
  },
  {
    name: 'meet_get_space',
    description: 'Get a Google Meet space by name (spaces/xxx).',
    schema: { org_id: z.string(), space: z.string() },
    tool: 'google-meet',
    action: 'meet_get_space',
  },
  {
    name: 'search_console_sites',
    description: 'List sites in the org-connected Google Search Console account.',
    schema: { org_id: z.string() },
    tool: 'google-search-console',
    action: 'search_console_sites',
  },
  {
    name: 'search_console_query',
    description: 'Query Search Console search analytics for a siteUrl.',
    schema: {
      org_id: z.string(),
      siteUrl: z.string(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
    tool: 'google-search-console',
    action: 'search_console_query',
  },
  {
    name: 'business_list_locations',
    description: 'List Google Business Profile accounts and locations.',
    schema: { org_id: z.string(), account: z.string().optional() },
    tool: 'google-business-profile',
    action: 'business_list_locations',
  },
  {
    name: 'cloud_list_projects',
    description: 'List GCP projects via Cloud Resource Manager for the org-connected Google Cloud account.',
    schema: { org_id: z.string() },
    tool: 'google-cloud',
    action: 'cloud_list_projects',
  },
  {
    name: 'analytics_report',
    description: 'Run a report query against the org-connected Google Analytics property.',
    schema: { org_id: z.string(), propertyId: z.string() },
    tool: 'google-analytics',
    action: 'analytics_report',
  },
  {
    name: 'outlook_list_messages',
    description: 'List recent messages from the org-connected Microsoft Outlook mailbox.',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'microsoft-outlook',
    action: 'list_messages',
  },
  {
    name: 'outlook_draft_email',
    description: 'Create an Outlook draft (does NOT send) for the org-connected Microsoft account.',
    schema: {
      org_id: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
    },
    tool: 'microsoft-outlook',
    action: 'draft_email',
  },
  {
    name: 'outlook_send',
    description: 'Send an email from the org-connected Microsoft Outlook account. Confirm class send.',
    schema: {
      org_id: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      cc: z.string().optional(),
    },
    tool: 'microsoft-outlook',
    action: 'send_email',
  },
  {
    name: 'outlook_calendar_list_events',
    description: 'List upcoming events from the org-connected Outlook Calendar.',
    schema: {
      org_id: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
    },
    tool: 'microsoft-calendar',
    action: 'list_events',
  },
  {
    name: 'outlook_calendar_create_event',
    description: 'Create an event on the org-connected Outlook Calendar.',
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
    tool: 'microsoft-calendar',
    action: 'create_event',
  },
  {
    name: 'outlook_calendar_check_availability',
    description: 'Find free slots on the org-connected Outlook Calendar.',
    schema: {
      org_id: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      durationMinutes: z.number().optional(),
      dayStart: z.string().optional(),
      dayEnd: z.string().optional(),
    },
    tool: 'microsoft-calendar',
    action: 'check_availability',
  },
  {
    name: 'salesforce_list_contacts',
    description: 'List contacts from the org-connected Salesforce org.',
    schema: { org_id: z.string(), count: z.number().optional(), email: z.string().optional() },
    tool: 'salesforce',
    action: 'list_contacts',
  },
  {
    name: 'salesforce_create_contact',
    description: 'Create a Contact in the org-connected Salesforce org.',
    schema: {
      org_id: z.string(),
      lastName: z.string().optional(),
      firstName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      accountId: z.string().optional(),
    },
    tool: 'salesforce',
    action: 'create_contact',
  },
  {
    name: 'salesforce_create_lead',
    description: 'Create a Lead in the org-connected Salesforce org.',
    schema: {
      org_id: z.string(),
      lastName: z.string(),
      company: z.string(),
      firstName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    },
    tool: 'salesforce',
    action: 'create_lead',
  },
  {
    name: 'salesforce_list_deals',
    description:
      'List Opportunities (deals) from the org-connected Salesforce org. Returns notConnected when unsigned.',
    schema: { org_id: z.string(), count: z.number().optional(), limit: z.number().optional() },
    tool: 'salesforce',
    action: 'list_deals',
  },
  {
    name: 'salesforce_create_deal',
    description:
      'Create an Opportunity in Salesforce. Returns the real Salesforce id; never invents ids. notConnected when unsigned.',
    schema: {
      org_id: z.string(),
      name: z.string().optional(),
      dealname: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      stage: z.string().optional(),
      stageName: z.string().optional(),
      closeDate: z.string().optional(),
      accountId: z.string().optional(),
    },
    tool: 'salesforce',
    action: 'create_deal',
  },
  {
    name: 'salesforce_update_deal',
    description:
      'Update a Salesforce Opportunity by real dealId from list_deals/create_deal. Never invent ids.',
    schema: {
      org_id: z.string(),
      dealId: z.string().optional(),
      opportunityId: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      stage: z.string().optional(),
      stageName: z.string().optional(),
      closeDate: z.string().optional(),
    },
    tool: 'salesforce',
    action: 'update_deal',
  },
  {
    name: 'docusign_list_envelopes',
    description: 'List envelopes from the org-connected DocuSign account.',
    schema: { org_id: z.string(), fromDate: z.string().optional() },
    tool: 'docusign',
    action: 'list_envelopes',
  },
  {
    name: 'docusign_create_envelope',
    description: 'Create a DocuSign draft envelope (does NOT send). Requires a real document.',
    schema: {
      org_id: z.string(),
      signerEmail: z.string().optional(),
      signerName: z.string().optional(),
      emailSubject: z.string().optional(),
      documentText: z.string().optional(),
      documentBase64: z.string().optional(),
      documentName: z.string().optional(),
    },
    tool: 'docusign',
    action: 'create_envelope',
  },
  {
    name: 'docusign_send_envelope',
    description: 'Send a DocuSign envelope for signature. Confirm class sign. Requires a real document.',
    schema: {
      org_id: z.string(),
      signerEmail: z.string().optional(),
      signerName: z.string().optional(),
      emailSubject: z.string().optional(),
      documentText: z.string().optional(),
      documentBase64: z.string().optional(),
      documentName: z.string().optional(),
    },
    tool: 'docusign',
    action: 'send_envelope',
  },
  {
    name: 'maps_geocode',
    description: 'Geocode an address via Google Maps Geocoding API (GOOGLE_MAPS_API_KEY).',
    schema: { org_id: z.string(), address: z.string() },
    tool: 'maps',
    action: 'geocode',
  },
  {
    name: 'maps_reverse_geocode',
    description: 'Reverse-geocode coordinates via Google Maps Geocoding API.',
    schema: {
      org_id: z.string(),
      latlng: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    },
    tool: 'maps',
    action: 'reverse_geocode',
  },
  {
    name: 'twilio_send_sms',
    description: 'Send an SMS via the org-connected Twilio account. Confirm class send.',
    schema: {
      org_id: z.string(),
      to: z.string(),
      body: z.string(),
      from: z.string().optional(),
    },
    tool: 'twilio',
    action: 'send_sms',
  },
  {
    name: 'twilio_list_messages',
    description: 'List recent SMS messages from the org-connected Twilio account.',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'twilio',
    action: 'list_messages',
  },
  {
    name: 'zoho_list_contacts',
    description: 'List contacts from the org-connected Zoho CRM account.',
    schema: { org_id: z.string(), count: z.number().optional(), email: z.string().optional() },
    tool: 'zoho-crm',
    action: 'list_contacts',
  },
  {
    name: 'zoho_create_contact',
    description: 'Create a Contact in the org-connected Zoho CRM account.',
    schema: {
      org_id: z.string(),
      lastName: z.string().optional(),
      firstName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    },
    tool: 'zoho-crm',
    action: 'create_contact',
  },
  {
    name: 'zoho_create_lead',
    description: 'Create a Lead in the org-connected Zoho CRM account.',
    schema: {
      org_id: z.string(),
      lastName: z.string(),
      company: z.string(),
      firstName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    },
    tool: 'zoho-crm',
    action: 'create_lead',
  },
  {
    name: 'zoho_list_deals',
    description: 'List Deals from the org-connected Zoho CRM account. Returns notConnected when unsigned.',
    schema: { org_id: z.string(), count: z.number().optional(), limit: z.number().optional() },
    tool: 'zoho-crm',
    action: 'list_deals',
  },
  {
    name: 'zoho_create_deal',
    description:
      'Create a Deal in Zoho CRM. Returns the real Zoho id; never invents ids. notConnected when unsigned.',
    schema: {
      org_id: z.string(),
      name: z.string().optional(),
      dealname: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      stage: z.string().optional(),
    },
    tool: 'zoho-crm',
    action: 'create_deal',
  },
  {
    name: 'zoho_update_deal',
    description: 'Update a Zoho Deal by real dealId from list_deals/create_deal. Never invent ids.',
    schema: {
      org_id: z.string(),
      dealId: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      stage: z.string().optional(),
    },
    tool: 'zoho-crm',
    action: 'update_deal',
  },
  {
    name: 'leegality_list_documents',
    description: 'List e-sign documents from the org-connected Leegality account.',
    schema: { org_id: z.string(), count: z.number().optional(), irn: z.string().optional(), search: z.string().optional() },
    tool: 'leegality',
    action: 'list_documents',
  },
  {
    name: 'leegality_create_document',
    description: 'Create a Leegality e-sign request (confirm class sign). Requires a real document and workflow profileId. Leegality has no draft envelope.',
    schema: {
      org_id: z.string(),
      profileId: z.string().optional(),
      signerEmail: z.string().optional(),
      signerName: z.string().optional(),
      signerPhone: z.string().optional(),
      documentText: z.string().optional(),
      documentBase64: z.string().optional(),
      documentName: z.string().optional(),
      irn: z.string().optional(),
    },
    tool: 'leegality',
    action: 'create_document',
  },
  {
    name: 'leegality_send_document',
    description: 'Send a Leegality e-sign request. Confirm class sign. Requires a real document — Darex will not invent contract contents.',
    schema: {
      org_id: z.string(),
      profileId: z.string().optional(),
      signerEmail: z.string().optional(),
      signerName: z.string().optional(),
      signerPhone: z.string().optional(),
      documentText: z.string().optional(),
      documentBase64: z.string().optional(),
      documentName: z.string().optional(),
      irn: z.string().optional(),
    },
    tool: 'leegality',
    action: 'send_document',
  },
  {
    name: 'quickbooks_list_customers',
    description: 'List customers from the org-connected QuickBooks company.',
    schema: { org_id: z.string(), count: z.number().optional(), email: z.string().optional() },
    tool: 'quickbooks',
    action: 'list_customers',
  },
  {
    name: 'quickbooks_create_customer',
    description: 'Create a Customer in the org-connected QuickBooks company.',
    schema: {
      org_id: z.string(),
      displayName: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
    },
    tool: 'quickbooks',
    action: 'create_customer',
  },
  {
    name: 'quickbooks_list_invoices',
    description: 'List invoices from the org-connected QuickBooks company. Never invents invoice rows.',
    schema: { org_id: z.string(), count: z.number().optional() },
    tool: 'quickbooks',
    action: 'list_invoices',
  },
  {
    name: 'metrics_query',
    description:
      'Query registered semantic metrics by id (e.g. core.inquiries_unworked / Unworked inquiries). Prefer this over raw database_query for KPIs. Numbers match the YAML SQL definitions under RLS.',
    schema: {
      org_id: z.string(),
      metricIds: z.array(z.string()).optional(),
      ids: z.array(z.string()).optional(),
      query: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    },
    tool: 'metrics',
    action: 'query',
  },
  {
    name: 'metrics_list',
    description: 'List registered semantic metric ids and aliases (Unworked inquiries, open conversations, etc.).',
    schema: { org_id: z.string() },
    tool: 'metrics',
    action: 'list',
  },
  {
    name: 're_listings_search',
    description:
      'Search org listing projection / Sheets inventory with structured filters (BHK, locality, maxPrice). Returns only stored rows. Zero matches does not invent inventory. Never scrape portals.',
    schema: {
      org_id: z.string(),
      bhk: z.union([z.number(), z.string()]).optional(),
      locality: z.string().optional(),
      city: z.string().optional(),
      area: z.string().optional(),
      maxPrice: z.union([z.number(), z.string()]).optional(),
      spreadsheetId: z.string().optional(),
    },
    tool: 're',
    action: 'listings_search',
  },
  {
    name: 're_listings_get',
    description: 'Get one listing by id or source_ref from this org projection. Does not invent units.',
    schema: {
      org_id: z.string(),
      id: z.string().optional(),
      listingId: z.string().optional(),
      sourceRef: z.string().optional(),
    },
    tool: 're',
    action: 'listings_get',
  },
  {
    name: 're_inquiry_create',
    description: 'Create a re.inquiry row for this org. Does not mark connectors connected.',
    schema: {
      org_id: z.string(),
      listingId: z.string().optional(),
      contactId: z.string().optional(),
      channel: z.string().optional(),
      bhk: z.union([z.number(), z.string()]).optional(),
      locality: z.string().optional(),
      budget_max: z.union([z.number(), z.string()]).optional(),
    },
    tool: 're',
    action: 'inquiry_create',
  },
  {
    name: 're_inquiry_listing_match',
    description:
      'Match open inquiries to active listings and queue waiting_approval opportunity cards. Never sends outreach. Honest empty when RE tables or rows are missing.',
    schema: { org_id: z.string() },
    tool: 're',
    action: 'inquiry_listing_match',
  },
  {
    name: 'growth_list_dormant_leads',
    description:
      'List dormant leads that recently showed intent (Growth). Read-only; empty when no data or tables missing.',
    schema: { org_id: z.string(), staleDays: z.number().optional() },
    tool: 'growth',
    action: 'list_dormant_leads',
  },
  {
    name: 'growth_list_pipeline_attribution',
    description:
      'List Growth pipeline attribution rows for this org. Read-only; empty when none exist.',
    schema: { org_id: z.string(), limit: z.number().optional() },
    tool: 'growth',
    action: 'list_pipeline_attribution',
  },
  {
    name: 'growth_pipeline_roi',
    description:
      'Read Growth pipeline ROI aggregates (by stage). Read-only; empty when no attribution rows.',
    schema: { org_id: z.string() },
    tool: 'growth',
    action: 'pipeline_roi',
  },
  {
    name: 're_showing_book',
    description:
      'Book a showing. Uses Google Calendar when connected; otherwise notConnected and not booked.',
    schema: {
      org_id: z.string(),
      listingId: z.string().optional(),
      inquiryId: z.string().optional(),
      startTime: z.string(),
      endTime: z.string().optional(),
      summary: z.string().optional(),
    },
    tool: 're',
    action: 'showing_book',
  },
  {
    name: 'rera_lookup',
    description:
      'Look up a RERA id in the official cache (URL + retrieved_at). Never invents a registration number. Not a legal opinion.',
    schema: {
      org_id: z.string(),
      rera_id: z.string().optional(),
      reraId: z.string().optional(),
      market: z.string().optional(),
    },
    tool: 'rera',
    action: 'lookup',
  },
  {
    name: 'cognee_memory_search',
    description:
      'Search organization memory (Cognee knowledge graph + Hindsight) for relational facts, entities, connections, and multi-hop organizational memory. Returns grounded citations.',
    schema: {
      org_id: z.string(),
      query: z.string(),
      searchType: z.enum(['GRAPH_COMPLETION', 'HYBRID_COMPLETION', 'CHUNKS', 'SUMMARIES']).optional(),
      topK: z.number().optional(),
    },
    tool: 'cognee',
    action: 'search',
  },
  {
    name: 'cognee_memory_remember',
    description:
      'Store durable knowledge, customer preferences, verified business facts, or relationship data into organization memory (Cognee + Hindsight).',
    schema: {
      org_id: z.string(),
      text: z.string(),
      sessionId: z.string().optional(),
    },
    tool: 'cognee',
    action: 'remember',
  },
  {
    name: 'stripe_create_refund',
    description:
      'Create a Stripe refund for a charge or payment intent. Always requires human approval before money moves. Never invents a refund id.',
    schema: {
      org_id: z.string(),
      chargeId: z.string().optional(),
      paymentIntentId: z.string().optional(),
      amount: z.number().optional(),
      reason: z.string().optional(),
    },
    tool: 'stripe',
    action: 'create_refund',
    risk: 'pay',
    confirm: true,
  },
  {
    name: 'hubspot_search_contacts',
    description:
      'Search HubSpot contacts by email or free-text query on the org-connected HubSpot CRM. Read-only.',
    schema: {
      org_id: z.string(),
      query: z.string().optional(),
      email: z.string().optional(),
      limit: z.number().optional(),
    },
    tool: 'hubspot',
    action: 'search_contacts',
  },
  {
    name: 'customer_list_open_loops',
    description:
      'List this org\'s open customer promises / open loops from agent_open_loops (org-scoped). Returns an empty list when none exist or the table is unavailable — never invents rows.',
    schema: {
      org_id: z.string(),
      customerIdentifier: z.string().optional(),
      limit: z.number().optional(),
    },
    tool: 'customer-ops',
    action: 'list_open_loops',
  },
  {
    name: 'customer_list_at_risk',
    description:
      'List recent at-risk / frustrated / unresolved conversations for this org (org-scoped). Returns an empty list when none exist or columns are unavailable — never invents rows.',
    schema: {
      org_id: z.string(),
      limit: z.number().optional(),
    },
    tool: 'customer-ops',
    action: 'list_at_risk_conversations',
  },
  {
    name: 'calendar_update_event',
    description:
      'Update a Google Calendar event (times, summary, attendees) or inject a Google Meet link via injectVideoLink. Uses the org-connected Google Calendar; never invents events.',
    schema: {
      org_id: z.string(),
      eventId: z.string(),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      injectVideoLink: z.boolean().optional(),
    },
    tool: 'google-calendar',
    action: 'update_event',
  },
  {
    name: 'ops_reconcile_audit',
    description:
      'Run cross-system reconciliation (enquiries vs CRM entities). Flags missing, duplicate, and stale records. Does not invent CRM rows.',
    schema: {
      org_id: z.string(),
      staleDaysThreshold: z.number().optional(),
    },
    tool: 'operations',
    action: 'reconcile_audit',
  },
  {
    name: 'ops_dedup_contacts',
    description:
      'Scan org entities for duplicate accounts, or check one contact by name/domain/phone. Reports merge/quarantine decisions only — does not merge HubSpot or send mail.',
    schema: {
      org_id: z.string(),
      name: z.string().optional(),
      domain: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      company: z.string().optional(),
    },
    tool: 'operations',
    action: 'dedup_contacts',
  },
  {
    name: 'ops_calendar_deadlocks',
    description:
      'Audit Google Calendar for missing Meet links, double-booked overlaps, and unconfirmed guests. Set injectMeetLinks=true to inject Meet via google-calendar update_event. Does not email guests or Slack.',
    schema: {
      org_id: z.string(),
      injectMeetLinks: z.boolean().optional(),
    },
    tool: 'operations',
    action: 'calendar_deadlocks',
  },
  {
    name: 'ops_meeting_prep',
    description:
      'Compile meeting prep briefs from a named meeting or from upcoming calendar events. Uses compileMeetingBrief; does not invent attendee history.',
    schema: {
      org_id: z.string(),
      meetingId: z.string().optional(),
      title: z.string().optional(),
      summary: z.string().optional(),
      startTime: z.string().optional(),
      attendeeEmail: z.string().optional(),
      attendeeName: z.string().optional(),
      customerBackground: z.string().optional(),
      openIssues: z.array(z.string()).optional(),
      facts: z.array(z.string()).optional(),
    },
    tool: 'operations',
    action: 'meeting_prep',
  },
  {
    name: 'work_item_create',
    description:
      'Create an internal work item (title, priority, optional assignee). Does not send email or Slack.',
    schema: {
      org_id: z.string(),
      title: z.string(),
      type: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      assigneeEmployeeId: z.string().optional(),
      dueAt: z.string().optional(),
    },
    tool: 'operations',
    action: 'work_item_create',
  },
  {
    name: 'work_item_reassign',
    description:
      'Reassign a work item to another employee (or null to unassign). Internal only — no email/Slack side effect.',
    schema: {
      org_id: z.string(),
      id: z.string(),
      assigneeEmployeeId: z.string().nullable(),
    },
    tool: 'operations',
    action: 'work_item_reassign',
  },
  {
    name: 'work_item_set_priority',
    description:
      'Change work item priority (low|normal|high|urgent). Internal only — no email/Slack side effect.',
    schema: {
      org_id: z.string(),
      id: z.string(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']),
    },
    tool: 'operations',
    action: 'work_item_set_priority',
  },
  {
    name: 'ops_list_discrepancies',
    description:
      'List open expected-vs-actual operational discrepancies for this org. Never invents overdue items.',
    schema: { org_id: z.string() },
    tool: 'operations',
    action: 'list_discrepancies',
  },
  {
    name: 'rent_reminders_list',
    description:
      'List open rent charges due within daysAhead and return draft reminder text. Does not send email; outbound send still needs approval. Never invents charges.',
    schema: {
      org_id: z.string(),
      daysAhead: z.number().optional(),
    },
    tool: 'operations',
    action: 'rent_reminders_list',
  },
  {
    name: 'connectors_status',
    description:
      'Read-only: check which connectors this org has connected. Probes the live OAuth connection (connected:true only when verified) and returns a /connectors link for anything not connected. Optional connector key checks one. Cannot connect or disconnect — those stay on the Connectors page.',
    schema: {
      org_id: z.string(),
      connector: z.string().optional(),
    },
    tool: 'connectors',
    action: 'status',
  },
  {
    name: 'daily_brief',
    description:
      'Read the org daily executive brief from real work_items (open exceptions and overnight handled count). Returns an honest empty brief when nothing is open — never invents items.',
    schema: {
      org_id: z.string(),
      limit: z.number().optional(),
    },
    tool: 'daily_brief',
    action: 'read',
  },

];

interface SessionContext {
  orgId?: string;
  userId?: string;
  /** Signed employee role. Model-supplied employee_role cannot override this. */
  employeeRole?: string;
  /** Per-turn employee tool allowlist from signed headers (undefined = org union). */
  toolAllowlist?: string[];
  /** True when tenant headers carried a valid HMAC signature. */
  signed: boolean;
  lastSeen: number;
}

function createServer(context?: SessionContext): McpServer {
  const server = new McpServer({
    name: 'darex',
    version: '0.1.0',
  });

  for (const toolDef of TOOLS) {
    const { name, description, schema, tool, action } = toolDef;
    const riskMeta = resolveToolRisk(tool, action);
    toolDef.risk = riskMeta?.risk;
    toolDef.confirm = riskMeta?.confirm;

    // Tenancy is header-derived ONLY. org_id is stripped from the schema so
    // models cannot supply (or spoof) it; any org_id argument is ignored and
    // the call is rejected unless the transport headers carried a valid org.
    const adjustedSchema: Record<string, z.ZodTypeAny> = { ...schema };
    delete adjustedSchema.org_id;

    server.registerTool(name, {
      description: `${description} (Tenant is resolved automatically — do not pass org_id.)`,
      inputSchema: adjustedSchema as any,
      annotations: {
        readOnlyHint: riskMeta?.risk === 'read',
        destructiveHint: riskMeta?.confirm === true || riskMeta?.risk === 'delete',
      },
    }, async (args: any) => {
      try {
        const orgId = context?.orgId || '';
        const payload: Record<string, any> = { ...args };
        delete payload.org_id;

        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(orgId)) {
          return textContent(JSON.stringify({
            status: 'error',
            message: 'Tenant context missing: this tool call carried no signed x-org-id header. Reconnect to /sse with tenant headers.',
            data: null,
            connected: false,
            setupUrl: '/connectors',
          }, null, 2));
        }
        // Fail closed per-tool: a secret is configured but this session wasn't
        // HMAC-verified at connect time (expired ts, bad sig, unsigned).
        // SessionId possession alone must never authorize tool execution.
        if (BRIDGE_SECRET && context?.signed !== true) {
          return textContent(JSON.stringify({
            status: 'error',
            message: 'Tenant context unsigned: reconnect to /sse with fresh signed x-tfg-mcp-headers.',
            data: null,
            connected: false,
            setupUrl: '/connectors',
          }, null, 2));
        }

        if (tool === 'file_ops') {
          const fileAction = String(args.action || 'read_file');
          delete payload.action;
          const result = await executeAutonomousToolAction({
            tool,
            action: fileAction,
            payload,
            orgId,
            employeeRole: context?.employeeRole,
            toolAllowlist: context?.toolAllowlist,
          });
          return textContent(formatResult(result));
        }

        const result = await executeAutonomousToolAction({
          tool,
          action,
          payload,
          orgId,
          employeeRole: context?.employeeRole
            || (typeof args.employee_role === 'string' ? args.employee_role : undefined),
          toolAllowlist: context?.toolAllowlist,
        });
        return textContent(formatResult(result));
      } catch (err: any) {
        return textContent(JSON.stringify({
          status: 'error',
          message: err?.message || 'Tool execution failed',
          data: null,
        }, null, 2));
      }
    });
  }

  return server;
}

function textContent(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

const transports: Record<string, SSEServerTransport> = {};
const sessionContexts: Record<string, SessionContext> = {};

// Evict idle sessions so unclean disconnects can't leak forever.
// `unref` so the sweeper never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [id, ctx] of Object.entries(sessionContexts)) {
    if (now - ctx.lastSeen > SESSION_IDLE_MS) {
      delete transports[id];
      delete sessionContexts[id];
    }
  }
}, 60_000).unref?.();

let unsignedWarned = false;

function parseToolAllowlistHeader(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return undefined;
    const out = arr.filter((t): t is string => typeof t === 'string' && !!t).slice(0, 100);
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function parseTenantHeaders(req: http.IncomingMessage): SessionContext {
  const now = Date.now();
  let orgId = (req.headers['x-org-id'] as string) || undefined;
  let userId = (req.headers['x-user-id'] as string) || undefined;
  let ts = (req.headers['x-ts'] as string) || undefined;
  let sig = (req.headers['x-sig'] as string) || undefined;
  let rawAllowlist = req.headers['x-tool-allowlist'] as string | undefined;
  let employeeRole = typeof req.headers['x-employee-role'] === 'string'
    ? req.headers['x-employee-role'].slice(0, 80)
    : undefined;
  let toolAllowlist = parseToolAllowlistHeader(rawAllowlist);

  const tfgHeadersRaw = req.headers['x-tfg-mcp-headers'] as string | undefined;
  if (tfgHeadersRaw) {
    try {
      const parsed = JSON.parse(tfgHeadersRaw);
      if (parsed.darex && typeof parsed.darex === 'object') {
        if (parsed.darex['x-org-id']) orgId = String(parsed.darex['x-org-id']);
        if (parsed.darex['x-user-id']) userId = String(parsed.darex['x-user-id']);
        if (parsed.darex['x-ts']) ts = String(parsed.darex['x-ts']);
        if (parsed.darex['x-sig']) sig = String(parsed.darex['x-sig']);
        if (parsed.darex['x-tool-allowlist']) {
          rawAllowlist = String(parsed.darex['x-tool-allowlist']);
          toolAllowlist = parseToolAllowlistHeader(rawAllowlist);
        }
        if (parsed.darex['x-employee-role']) {
          employeeRole = String(parsed.darex['x-employee-role']).slice(0, 80);
        }
      }
    } catch {
      // ignore invalid json in x-tfg-mcp-headers
    }
  }

  // Verify HMAC when a bridge secret is configured.
  // v3 binds org.user.ts.allowlist.role. v2 (no role) and v1 (no user)
  // stay valid so older callers keep working. A role header is honored only
  // when the signature includes it.
  if (BRIDGE_SECRET) {
    const allowlistJson = typeof rawAllowlist === 'string'
      ? rawAllowlist
      : '[]';
    const tsNum = Number(ts || '');
    const fresh = Number.isFinite(tsNum) && Math.abs(now - tsNum) <= TENANT_TS_SKEW_MS;
    const role = (employeeRole || '').slice(0, 80);
    const candidates = [
      `${orgId || ''}.${userId || ''}.${ts || ''}.${allowlistJson}.${role}`,
      `${orgId || ''}.${userId || ''}.${ts || ''}.${allowlistJson}`,
      `${orgId || ''}.${ts || ''}.${allowlistJson}`,
    ];
    let valid = false;
    let matchedRole = false;
    if (fresh && sig) {
      for (let i = 0; i < candidates.length; i += 1) {
        const expected = createHmac('sha256', BRIDGE_SECRET).update(candidates[i], 'utf8').digest('hex');
        try {
          if (sig.length === expected.length &&
            timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
            valid = true;
            matchedRole = i === 0 && role.length > 0;
            break;
          }
        } catch {
          // try next candidate
        }
      }
    }
    if (!valid || !orgId) {
      if (orgId || sig) {
        console.warn(`[mcp-bridge] auth failed: orgId=${orgId} userId=${userId} ts=${ts} fresh=${fresh} hasSig=${!!sig}`);
      }
      return { signed: false, lastSeen: now };
    }
    return {
      orgId,
      userId,
      toolAllowlist,
      employeeRole: matchedRole ? role : undefined,
      signed: true,
      lastSeen: now,
    };
  }

  if (process.env.NODE_ENV === 'production') {
    // Fail closed: production must never serve unsigned tenant traffic.
    console.error('[mcp-bridge] refusing unsigned tenant headers in production (set MCP_BRIDGE_SECRET)');
    return { signed: false, lastSeen: now };
  }
  if (!unsignedWarned) {
    unsignedWarned = true;
    console.warn('[mcp-bridge] accepting UNSIGNED tenant headers (dev only — set MCP_BRIDGE_SECRET)');
  }
  return { orgId, userId, toolAllowlist, employeeRole, signed: false, lastSeen: now };
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'darex', tools: TOOLS.length, sse: SSE_ENDPOINT }));
      return;
    }
    // Deep health: DB pool probe with a short deadline. Load balancers must
    // route away when the pool is down — every tool needs it.
    let db: 'up' | 'down' = 'down';
    try {
      await Promise.race([
        dbPool.query('SELECT 1'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db probe timeout')), 2000)),
      ]);
      db = 'up';
    } catch {
      db = 'down';
    }
    const ctxList = Object.values(sessionContexts);
    const body = {
      ok: db === 'up',
      server: 'darex',
      tools: TOOLS.length,
      sse: SSE_ENDPOINT,
      db,
      sessions: Object.keys(transports).length,
      sessionsSigned: ctxList.filter((c) => c.signed).length,
      sessionsUnsigned: ctxList.filter((c) => !c.signed).length,
      orgs: new Set(ctxList.map((c) => c.orgId).filter(Boolean)).size,
      uptimeSec: Math.round(process.uptime()),
    };
    res.writeHead(db === 'up' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === SSE_ENDPOINT) {
    if (Object.keys(transports).length >= MAX_SESSIONS) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Too many SSE sessions. Retry later.');
      return;
    }
    const context = parseTenantHeaders(req);
    // Per-org quota with LRU eviction: one tenant can't starve the pool.
    // Unsigned contexts share a single '' bucket so anon traffic can't either.
    if (context.orgId) {
      const orgSessions = Object.entries(sessionContexts)
        .filter(([, c]) => c.orgId === context.orgId)
        .sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
      const cap = Number.isFinite(MAX_SESSIONS_PER_ORG) && MAX_SESSIONS_PER_ORG > 0
        ? MAX_SESSIONS_PER_ORG : 20;
      while (orgSessions.length >= cap) {
        const oldest = orgSessions.shift();
        if (!oldest) break;
        delete transports[oldest[0]];
        delete sessionContexts[oldest[0]];
      }
    }
    const transport = new SSEServerTransport(MESSAGE_ENDPOINT, res);
    transports[transport.sessionId] = transport;
    sessionContexts[transport.sessionId] = context;

    const keepaliveTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(': keepalive\n\n');
        }
      } catch {
        // Socket closed or error
      }
    }, 15000);

    res.on('close', () => {
      clearInterval(keepaliveTimer);
      delete transports[transport.sessionId];
      delete sessionContexts[transport.sessionId];
    });

    // One McpServer per connection bound to the session context
    const server = createServer(context);
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST' && url.pathname === MESSAGE_ENDPOINT) {
    const sessionId = url.searchParams.get('sessionId');
    const transport = sessionId ? transports[sessionId] : undefined;
    const ctx = sessionId ? sessionContexts[sessionId] : undefined;
    if (transport && ctx) {
      // Re-evaluate tenant headers if incoming message carries any.
      // TrueForge / RemoteMCP forwards per-turn headers on POST /messages.
      const incomingCtx = parseTenantHeaders(req);
      if (incomingCtx.signed) {
        ctx.orgId = incomingCtx.orgId;
        ctx.userId = incomingCtx.userId;
        ctx.toolAllowlist = incomingCtx.toolAllowlist;
        ctx.employeeRole = incomingCtx.employeeRole || ctx.employeeRole;
        ctx.signed = true;
      } else if (incomingCtx.orgId && !BRIDGE_SECRET) {
        ctx.orgId = incomingCtx.orgId;
        ctx.userId = incomingCtx.userId;
        ctx.toolAllowlist = incomingCtx.toolAllowlist;
        ctx.employeeRole = incomingCtx.employeeRole || ctx.employeeRole;
      }
      ctx.lastSeen = Date.now();
      try {
        await transport.handlePostMessage(req, res);
      } catch (err: any) {
        console.error('[mcp-bridge] POST /messages failed:', err?.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Message handling failed');
        }
      }
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
    `[mcp-bridge] MCP SSE server 'darex' listening on http://0.0.0.0:${PORT}${SSE_ENDPOINT} (${TOOLS.length} mcp.darex.* tools)`
  );
});

process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
