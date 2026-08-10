import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';
import { HERMES_TOOL_SUITE } from '@/lib/hermes-agent';

export async function GET() {
  const platformTools = [
    { name: 'whatsapp', category: 'Communication', description: 'Meta Cloud API WhatsApp messaging & auto-responder' },
    { name: 'gmail', category: 'Communication', description: 'Fetch live emails & send outbound messages via Gmail API' },
    { name: 'google-calendar', category: 'Productivity', description: 'Schedule events & check availability via Google Calendar API' },
    { name: 'hubspot', category: 'CRM', description: 'Create leads & sync customer records in HubSpot CRM' },
    { name: 'github', category: 'Development', description: 'Fetch repositories, commits, and pull requests via GitHub API' },
    { name: 'meta-ads', category: 'Marketing', description: 'Track campaign impressions, CTR, and spend via Meta Ads API' },
    { name: 'slack', category: 'Communication', description: 'Send channel notifications & team alerts via Slack Web API' },
    { name: 'stripe', category: 'Finance', description: 'Create checkout payment links & process payments via Stripe API' },
    { name: 'notion', category: 'Productivity', description: 'Search and sync database docs in Notion workspace' },
    { name: 'zendesk', category: 'Support', description: 'Create & update customer support tickets in Zendesk' },
  ];

  const hermesTools = HERMES_TOOL_SUITE.map((t) => ({
    name: t.name,
    category: 'Hermes Engine',
    description: t.description,
  }));

  const nativePythonToolsets = [
    { name: 'web', category: 'Hermes Native', description: 'Web search & content extraction (web_search, web_extract)' },
    { name: 'skills', category: 'Hermes Native', description: 'Dynamic skill management (skills_list, skill_view, skill_manage)' },
    { name: 'files', category: 'Hermes Native', description: 'File & code manipulation (read_file, write_file, patch, search_files)' },
    { name: 'planning', category: 'Hermes Native', description: 'Task planning & trajectory memory (todo, memory, session_search)' },
    { name: 'code_execution', category: 'Hermes Native', description: 'Code execution & task delegation (execute_code, delegate_task)' },
    { name: 'vision', category: 'Hermes Native', description: 'Multimodal image analysis (vision_analyze)' },
    { name: 'browser', category: 'Hermes Native', description: 'Playwright & CDP browser automation (browser_navigate, click, snapshot)' },
  ];

  return NextResponse.json({
    tools: [...platformTools, ...hermesTools, ...nativePythonToolsets],
    totalCount: platformTools.length + hermesTools.length + nativePythonToolsets.length,
  });
}

import { pool } from '@/lib/db';

export async function POST(request: Request) {
  let client = null;
  try {
    const body = await request.json();
    const { tool, action, payload, orgId: bodyOrgId } = body;

    let orgId = bodyOrgId;
    
    if (orgId) {
      // Server-to-server request from Hermes Python script
      client = await pool.connect();
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    } else {
      // Frontend request
      const scoped = await getScopedClient();
      client = scoped.client;
      orgId = scoped.orgId;
    }

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
