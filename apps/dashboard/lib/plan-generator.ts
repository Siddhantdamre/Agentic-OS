// Plan generator for the Reasoning + Plan-Confirm-Execute flow.
//
// When the classifier marks a request COMPLEX, we ask LiteLLM (one plain,
// non-streaming completion) to decompose the request into an explicit,
// approvable step sequence + optional draft + reasoning. This bypasses
// atomic-agent's agent loop — the planner only needs structured JSON out,
// never tool execution.

import { chatCompletion } from './litellm-client';
import type { GeneratedPlan, PlanStep } from '@darex/shared-types';

export type { GeneratedPlan, PlanStep };

/** Always-available tools (no OAuth). Planner may use these even if no connector is connected. */
export const CORE_PLAN_TOOLS = [
  'database_query',
  'web_search',
  'web_extract',
  'file_ops',
  'sandbox',
] as const;

export const VALID_TOOLS = new Set<string>([
  'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets',
  'google-slides', 'google-forms', 'google-contacts', 'google-tasks',
  'github', 'whatsapp', 'hubspot', 'meta-ads', 'google-ads', 'slack', 'notion',
  'stripe', 'shopify', 'zendesk', 'intercom', 'razorpay',
  'google-analytics', 'google-chat', 'google-meet', 'google-search-console',
  'google-business-profile', 'google-cloud',
  ...CORE_PLAN_TOOLS,
]);

const TOOL_ALIASES: Record<string, string> = {
  calendar: 'google-calendar',
  google_calendar: 'google-calendar',
  'google-calendar': 'google-calendar',
  drive: 'google-drive',
  google_drive: 'google-drive',
  docs: 'google-docs',
  google_docs: 'google-docs',
  sheets: 'google-sheets',
  google_sheets: 'google-sheets',
  google_ads: 'google-ads',
  meta_ads: 'meta-ads',
  ga4: 'google-analytics',
  google_analytics: 'google-analytics',
  google_chat: 'google-chat',
  google_meet: 'google-meet',
  search_console: 'google-search-console',
  google_search_console: 'google-search-console',
  business_profile: 'google-business-profile',
  google_business_profile: 'google-business-profile',
  gcp: 'google-cloud',
  google_cloud: 'google-cloud',
  'database-query': 'database_query',
  db_query: 'database_query',
  sql: 'database_query',
  sql_analytics: 'database_query',
  code_execution: 'sandbox',
  execute_code: 'sandbox',
  'code-execution': 'sandbox',
};

export function normalizeToolName(raw: string): string {
  const key = String(raw || '').toLowerCase().trim();
  if (!key) return '';
  if (TOOL_ALIASES[key]) return TOOL_ALIASES[key];
  if (VALID_TOOLS.has(key)) return key;
  const dashed = key.replace(/_/g, '-');
  if (TOOL_ALIASES[dashed]) return TOOL_ALIASES[dashed];
  if (VALID_TOOLS.has(dashed)) return dashed;
  return key;
}

export function connectedPlannerTools(channelTypes: string[]): string[] {
  const fromChannels = channelTypes
    .map(normalizeToolName)
    .filter((t) => VALID_TOOLS.has(t));
  return Array.from(new Set<string>([...CORE_PLAN_TOOLS, ...fromChannels]));
}

function sanitizeSteps(raw: any[]): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  for (const s of raw.slice(0, 12)) {
    const tool = normalizeToolName(String(s?.tool || ''));
    const action = String(s?.action || '');
    if (!VALID_TOOLS.has(tool) || action.length === 0) continue;
    const payloadSig = JSON.stringify(s?.payload || {});
    const stepSig = `${tool}:${action}:${payloadSig}`;
    if (seen.has(stepSig)) continue;
    seen.add(stepSig);
    steps.push({
      id: `step-${steps.length + 1}`,
      description: String(s?.description || `${tool} → ${action}`).slice(0, 200),
      tool,
      action,
      payload: (s?.payload && typeof s?.payload === 'object' ? s?.payload : {}) as Record<string, any>,
      enabled: s?.enabled !== false,
    });
  }
  return steps;
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function generatePlan(
  prompt: string,
  orgId: string,
  connectedTools: string[]
): Promise<GeneratedPlan> {
  try {
    const allowed = connectedPlannerTools(connectedTools);
    const connectedLabel = allowed.join(', ');
    const systemPrompt = [
      'You are DareX Executive, planning an airtight multi-step automation.',
      `Organisation org_id=${orgId}. You MUST pass org_id to every mcp.darex.* tool you plan.`,
      `Allowed tools: ${connectedLabel}. Only plan steps with tools from this list.`,
      'Connector tools that are not in the allowed list are not connected — do not invent them or fake their results.',
      'Decompose the user request into the smallest set of concrete steps.',
      'Reply with ONLY a JSON object, no prose, no fences:',
      '{"reasoning": "1-2 sentence rationale", "summary": "one-line plan title", "steps": [{"description": "human step", "tool": "gmail", "action": "send_email", "payload": {"to":"x@y.com","subject":"...","body":"..."}}], "draft": "full drafted email/message content if the user wants a message authored, else empty string"}',
      'Rules:',
      '- step.tool must be one of the connected tools.',
      '- step.action must be a real action for that tool (e.g. gmail: fetch_latest_emails, triage_emails, draft_email, send_email, extract_otp, extract_attachment; google-calendar: check_availability, create_event, list_events; google-drive: drive_search, drive_list, drive_get_text, drive_upload, drive_share; google-docs: docs_create, docs_read, docs_append; google-sheets: sheets_create, sheets_read, sheets_append_row; hubspot: create_crm_contact, update_contact; github: create_repo, create_issue, fetch_user_repos; zendesk: create_support_ticket, update_ticket, fetch_tickets; notion: create_page, append_page_content, search_workspace_docs; google-analytics: analytics_report; google-chat: chat_list_spaces, chat_send_message; google-meet: meet_create_space, meet_get_space; google-search-console: search_console_sites, search_console_query; google-business-profile: business_list_locations; google-cloud: cloud_list_projects; database_query: query; web_search: search; web_extract: extract; sandbox: execute).',
      '- Step payloads must include all required params for the action.',
      '- To pass the result of a previous step (like search results or fetched content) into a text field, use the exact syntax {{stepN_output}} where N is the 1-based index (e.g. {{step1_output}}). DO NOT write placeholders like "[Insert results here]".',
      '- Never invent a user email/phone — if the user did not provide the recipient, leave the param empty and note it in description.',
      '- Keep steps to at most 6.',
      '- If the request is really only a simple reply, put 1 step (e.g. gmail draft_email) and author the email in draft.',
      'Begin your reply with the JSON object directly.',
    ].join('\n');

    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `USER REQUEST: ${prompt}` },
      ],
      { maxTokens: 1200, temperature: 0.2, timeoutMs: 60000 }
    );
    const parsed = extractJson(content);

    const steps = sanitizeSteps(parsed?.steps);
    if (steps.length === 0) {
      throw new Error('Planner returned no usable steps');
    }

    return {
      reasoning: String(parsed?.reasoning || '').slice(0, 500),
      summary: String(parsed?.summary || '').slice(0, 120),
      steps,
      draft: String(parsed?.draft || '').slice(0, 4000),
    };
  } catch (err) {
    console.warn('[Planner] LiteLLM call failed:', (err as Error)?.message);
    throw err;
  }
}

/**
 * Revise an existing draft based on user feedback. Returns the improved draft.
 */
export async function reviseDraft(
  originalRequest: string,
  currentDraft: string,
  feedback: string
): Promise<string> {
  try {
    const systemPrompt = [
      'You are DareX Executive, polishing a drafted message.',
      'Revise the provided draft to incorporate the user feedback.',
      'Preserve tone, keep the message focused and professional.',
      'Reply with ONLY the revised draft text. No JSON, no fences, no preamble.',
    ].join('\n');
    const userPrompt = [
      `ORIGINAL REQUEST:\n${originalRequest}\n`,
      `CURRENT DRAFT:\n${currentDraft}\n`,
      `USER FEEDBACK:\n${feedback}\n`,
      'Return the fully revised draft now:',
    ].join('\n');

    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { maxTokens: 1000, temperature: 0.2, timeoutMs: 60000 }
    );
    return content.trim().slice(0, 4000);
  } catch (err) {
    console.warn('[ReviseDraft] LiteLLM call failed:', (err as Error)?.message);
    throw err;
  }
}