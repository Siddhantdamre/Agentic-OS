export type EmployeePersona = 'growth' | 'customer' | 'operations' | 'sales' | 'marketing' | 'finance';

const PERSONA_DENIED_TOOLS: Record<EmployeePersona, string[]> = {
  growth: ['stripe', 'shopify', 'zendesk', 'intercom', 'razorpay'],
  customer: ['apollo', 'linkedin', 'google-ads', 'meta-ads'],
  operations: ['apollo', 'linkedin', 'google-ads', 'meta-ads', 'stripe'],
  sales: ['google-ads', 'meta-ads'],
  marketing: ['stripe', 'shopify', 'zendesk', 'intercom', 'razorpay'],
  finance: ['apollo', 'linkedin', 'google-ads', 'meta-ads'],
};

const PERSONA_DENIED_ACTIONS: Record<EmployeePersona, string[]> = {
  growth: ['delete', 'refund'],
  customer: ['delete', 'create_deal', 'update_deal', 'create_crm', 'cold'],
  operations: ['delete', 'refund', 'send_email', 'send_channel', 'send_external', 'draft_email'],
  sales: ['delete', 'refund'],
  marketing: ['delete', 'refund', 'create_charge', 'charge', 'payout'],
  finance: ['refund'],
};

function normalizeToolKey(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

function normalizeActionKey(value: string): string {
  return String(value || '').toLowerCase().replace(/-/g, '_');
}

export function normalizeEmployeePersona(role: string | null | undefined): EmployeePersona | null {
  if (!role) return null;
  const r = role.toLowerCase();
  // Marcus / Marketing & Analytics — never map marcus → growth.
  if (r.includes('marketing') || r.includes('analytics') || r.includes('marcus')) return 'marketing';
  if (r.includes('finance') || r.includes('cfo') || r.includes('bookkeep')) return 'finance';
  if (r.includes('growth') || r.includes('sdr')) return 'growth';
  // Sarah / Sales & Lead Gen — never map sarah → customer.
  if (r.includes('sales') || r.includes('lead') || r.includes('sarah')) return 'sales';
  if (r.includes('customer') || r.includes('support')) return 'customer';
  if (r.includes('operation') || r.includes('ops') || r.includes('isa')) return 'operations';
  return null;
}

function toolDeniedForPersona(persona: EmployeePersona, tool: string): boolean {
  const key = normalizeToolKey(tool);
  return PERSONA_DENIED_TOOLS[persona].some((denied) => {
    const d = normalizeToolKey(denied);
    return key === d || key.startsWith(`${d}-`) || key.startsWith(`${d}_`);
  });
}

function actionDeniedForPersona(persona: EmployeePersona, action: string): boolean {
  const key = normalizeActionKey(action);
  return PERSONA_DENIED_ACTIONS[persona].some((denied) => key.includes(denied));
}

export function filterAllowlistForPersona(
  allowlist: string[],
  role: string | null | undefined
): string[] {
  const persona = normalizeEmployeePersona(role);
  if (!persona) return [...allowlist];
  return allowlist.filter((tool) => !toolDeniedForPersona(persona, tool));
}

export function roleCapabilityDenial(
  role: string | null | undefined,
  tool: string,
  action?: string,
  grantedTools?: string[]
): string | null {
  const persona = normalizeEmployeePersona(role);
  if (!persona) return null;
  const granted = new Set((grantedTools || []).map(normalizeToolKey));
  const toolGranted = granted.has(normalizeToolKey(tool));
  if (toolDeniedForPersona(persona, tool) && !toolGranted) {
    return `${persona} employee cannot use ${tool}`;
  }
  if (action && actionDeniedForPersona(persona, action)) {
    if (toolGranted) {
      const act = normalizeActionKey(action);
      if (act.includes('delete')) {
        return `${persona} employee cannot ${action} via ${tool}`;
      }
      if (act.includes('refund') && persona !== 'customer') {
        return `${persona} employee cannot ${action} via ${tool}`;
      }
      if (
        (act.includes('create_charge') || act.includes('charge') || act.includes('payout')) &&
        persona === 'marketing'
      ) {
        return `${persona} employee cannot ${action} via ${tool}`;
      }
      if ((act.includes('create_deal') || act.includes('update_deal')) && persona === 'customer') {
        return `${persona} employee cannot ${action} via ${tool}`;
      }
      return null;
    }
    return `${persona} employee cannot ${action} via ${tool}`;
  }
  return null;
}
