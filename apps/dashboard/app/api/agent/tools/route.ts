import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';

export async function GET() {
  const platformTools = [
    { name: 'whatsapp', category: 'Communication', description: 'Meta Cloud API WhatsApp messaging & auto-responder' },
    { name: 'gmail', category: 'Communication', description: 'Fetch emails (full body + attachments), triage inbox, extract OTP codes, parse PDF attachments, create drafts & send via Gmail API' },
    { name: 'google-calendar', category: 'Productivity', description: 'Create events, check availability & find free time slots via Google Calendar API' },
    { name: 'hubspot', category: 'CRM', description: 'Create & update leads/contacts and sync customer records in HubSpot CRM' },
    { name: 'github', category: 'Development', description: 'Fetch repositories, create repos & issues, commits, and pull requests via GitHub API' },
    { name: 'meta-ads', category: 'Marketing', description: 'Track campaign impressions, CTR, and spend via Meta Ads API' },
    { name: 'slack', category: 'Communication', description: 'Send channel notifications & team alerts via Slack Web API' },
    { name: 'stripe', category: 'Finance', description: 'Create checkout payment links & process payments via Stripe API' },
    { name: 'notion', category: 'Productivity', description: 'Search, create pages & append content blocks in the Notion workspace' },
    { name: 'zendesk', category: 'Support', description: 'Create, fetch & update customer support tickets in Zendesk' },
    { name: 'shopify', category: 'E-Commerce', description: 'Order tracking, inventory queries & customer fulfillment sync' },
    { name: 'intercom', category: 'Support', description: 'Live customer chat sync & agent assignment' },
    { name: 'razorpay', category: 'Finance', description: 'Instant payment link generation & invoice status queries' },
    { name: 'google-drive', category: 'Productivity', description: 'Search, read, upload & share files across Google Drive' },
    { name: 'google-docs', category: 'Productivity', description: 'Create, read & append content in Google Docs documents' },
    { name: 'google-sheets', category: 'Productivity', description: 'Read, create & append rows in Google Sheets spreadsheets' },
  ];

  const atomicTools = [
    { name: 'database_query', category: 'Atomic Agent', description: 'Run a read-only SELECT query against the org-scoped business database' },
    { name: 'web_search', category: 'Atomic Agent', description: 'Perform a live web search for a query' },
    { name: 'web_extract', category: 'Atomic Agent', description: 'Extract clean text content from a web page URL' },
    { name: 'sql_analytics', category: 'Atomic Agent', description: 'Business analytics queries against org data' },
    { name: 'db_query', category: 'Atomic Agent', description: 'General database query alias for read-only access' },
    { name: 'file_ops', category: 'Atomic Agent', description: 'Read/write org workspace files (notes, scratch data)' },
  ];

  return NextResponse.json({
    tools: [...platformTools, ...atomicTools],
    totalCount: platformTools.length + atomicTools.length,
  });
}

import { pool } from '@/lib/db';

export async function POST(request: Request) {
  let client = null;
  try {
    const body = await request.json();
    const { tool, action, payload } = body;

    // Always authenticate via the session cookie. The org is resolved from the
    // authenticated user — a client-supplied orgId is NEVER trusted, so an
    // unauthenticated / cross-tenant caller can no longer execute tools against
    // an arbitrary org.
    const scoped = await getScopedClient();
    client = scoped.client;
    const orgId = scoped.orgId;

    try {
      if (!tool) {
        return NextResponse.json({ error: 'Tool parameter is required' }, { status: 400 });
      }

      const result = await executeAutonomousToolAction({
        tool,
        action: action || 'auto_execute',
        payload: payload || {},
        orgId,
      });

      // Audit log tool action in channel_logs
      try {
        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
           VALUES ($1, $2, 'TOOL_ACTION_EXECUTION', 'success', 200, $3, $4)`,
          [orgId, tool, result.message, JSON.stringify(result.data)]
        );
      } catch (e) {
        // Non-critical audit log
      }

      return NextResponse.json({ success: true, result });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/agent/tools Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
