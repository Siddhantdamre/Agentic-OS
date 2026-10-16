export type EmployeePersona = 'growth' | 'customer' | 'operations' | 'sales' | 'marketing' | 'finance';
const GROWTH_TOOLS = ['apollo_search', 'web_search', 'draft_email', 'ads_insights', 'linkedin_signals', 'hubspot_search'];
const CUSTOMER_TOOLS = ['knowledge_search', 'order_lookup', 'calendar_reschedule', 'ticket_update', 'gmail_read', 'whatsapp_send'];
const OPERATIONS_TOOLS = ['record_dedup', 'task_audit', 'meeting_brief', 'internal_ping', 'sheets_read', 'drive_list'];
const SALES_TOOLS = ['hubspot_search', 'apollo_search', 'linkedin_signals', 'gmail_read', 'draft_email'];
const MARKETING_TOOLS = ['ads_insights', 'web_search', 'gmail_read', 'analytics_report'];
const FINANCE_TOOLS = ['stripe', 'razorpay', 'quickbooks', 'billing_usage'];
const CORE_ALWAYS = ['web_search', 'database_query', 'db_query', 'file_ops', 'connectors_status'];
export function normalizePersona(role: string | null | undefined): EmployeePersona | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r.includes('marketing') || r.includes('analytics') || r.includes('marcus')) return 'marketing';
  if (r.includes('finance') || r.includes('cfo') || r.includes('bookkeep')) return 'finance';
  if (r.includes('growth') || r.includes('sdr')) return 'growth';
  if (r.includes('sales') || r.includes('lead') || r.includes('sarah')) return 'sales';
  if (r.includes('customer') || r.includes('support')) return 'customer';
  if (r.includes('operation') || r.includes('ops') || r.includes('isa')) return 'operations';
  return null;
}
export function toolsForPersona(persona: EmployeePersona): string[] {
  switch (persona) {
    case 'growth': return [...GROWTH_TOOLS];
    case 'customer': return [...CUSTOMER_TOOLS];
    case 'operations': return [...OPERATIONS_TOOLS];
    case 'sales': return [...SALES_TOOLS];
    case 'marketing': return [...MARKETING_TOOLS];
    case 'finance': return [...FINANCE_TOOLS];
    default: { const _exhaustive: never = persona; return _exhaustive; }
  }
}
export function filterAllowlistForPersona(allowlist: string[], role: string | null | undefined): string[] {
  const persona = normalizePersona(role);
  if (!persona) return [...new Set([...allowlist, ...CORE_ALWAYS])];
  const scoped = new Set([...toolsForPersona(persona), ...CORE_ALWAYS]);
  return allowlist.filter((tool) => scoped.has(tool) || CORE_ALWAYS.includes(tool));
}
export function roleCapabilityDenial(role: string, tool: string): string {
  return `${normalizePersona(role) || 'customer'} employee cannot use ${tool}`;
}
