import { VALID_TOOLS } from '@/lib/plan-generator';

/** Accept catalog tools plus common aliases already used on employee allowlists. */
const EXTRA_ALLOWED = new Set<string>([
  'web_search',
  'web_extract',
  'database_query',
  'knowledge_search',
  'order_lookup',
  'calendar_reschedule',
  'ticket_update',
  'gmail_read',
  'whatsapp_send',
  'gmail_send',
  'gmail_fetch',
  'cognee',
  'connectors_status',
  'daily_brief',
  'daily-brief',
  'executive_brief',
]);

export function normalizeToolName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

export function validateToolAllowlist(tools: string[]): { ok: true; tools: string[] } | { ok: false; invalid: string[] } {
  const normalized = tools.map(normalizeToolName).filter(Boolean);
  const invalid = normalized.filter((t) => !VALID_TOOLS.has(t) && !EXTRA_ALLOWED.has(t));
  if (invalid.length > 0) return { ok: false, invalid: [...new Set(invalid)] };
  return { ok: true, tools: [...new Set(normalized)] };
}
