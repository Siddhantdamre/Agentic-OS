// Plan generator for the Reasoning + Plan-Confirm-Execute flow.
//
// When the classifier marks a request COMPLEX, we ask LiteLLM (one plain,
// non-streaming completion) to decompose the request into an explicit,
// approvable step sequence + optional draft + reasoning. This bypasses
// atomic-agent's agent loop — the planner only needs structured JSON out,
// never tool execution.

import { chatCompletion } from './litellm-client';

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  action: string;
  payload: Record<string, any>;
  enabled: boolean;
}

export interface GeneratedPlan {
  reasoning: string;
  steps: PlanStep[];
  draft: string;
  summary: string;
}

const VALID_TOOLS = new Set([
  'gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets',
  'github', 'whatsapp', 'hubspot', 'meta-ads', 'google-ads', 'slack', 'notion',
  'stripe', 'shopify', 'zendesk', 'intercom', 'razorpay',
  'database_query', 'web_search', 'web_extract', 'file_ops', 'sandbox',
]);

function sanitizeSteps(raw: any[]): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  for (const s of raw.slice(0, 12)) {
    const tool = String(s?.tool || '').toLowerCase();
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
    const connected = connectedTools.length > 0 ? connectedTools.join(', ') : 'unknown — attempt tools, they may fall back gracefully';
    const systemPrompt = [
      'You are DareX Executive, planning an airtight multi-step automation.',
      `Organisation org_id=${orgId}. You MUST pass org_id to every mcp.darex.* tool you plan.`,
      `Connected tools: ${connected}. Only plan steps with tools from this list.`,
      'Decompose the user request into the smallest set of concrete steps.',
      'Reply with ONLY a JSON object, no prose, no fences:',
      '{"reasoning": "1-2 sentence rationale", "summary": "one-line plan title", "steps": [{"description": "human step", "tool": "gmail", "action": "send_email", "payload": {"to":"x@y.com","subject":"...","body":"..."}}], "draft": "full drafted email/message content if the user wants a message authored, else empty string"}',
      'Rules:',
      '- step.tool must be one of the connected tools.',
      '- step.action must be a real action for that tool (e.g. gmail: fetch_latest_emails, triage_emails, draft_email, send_email, extract_otp, extract_attachment; google-calendar: check_availability, create_event, list_events; google-drive: drive_search, drive_list, drive_get_text, drive_upload, drive_share; google-docs: docs_create, docs_read, docs_append; google-sheets: sheets_create, sheets_read, sheets_append_row; hubspot: create_crm_contact, update_contact; github: create_repo, create_issue, fetch_user_repos; zendesk: create_support_ticket, update_ticket, fetch_tickets; notion: create_page, append_page_content, search_workspace_docs; database_query: query; web_search: search; web_extract: extract).',
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
      { maxTokens: 800, temperature: 0.2, timeoutMs: 60000 }
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