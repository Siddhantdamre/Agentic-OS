export type RolloutStage = 0 | 1 | 2 | 3;
export type EmployeeGateVerdict = 'shadow' | 'allow' | 'escalate' | 'deny_role';
export interface EmployeeGateInput {
  killSwitch: boolean; rolloutStage: RolloutStage; employeeRole: string; actionType: string;
  reversibility: 'reversible' | 'visible' | 'irreversible';
}
const GROWTH_DENIED = ['refund', 'refund_payment', 'delete_record', 'ticket_update'];
const CUSTOMER_DENIED = ['apollo_search', 'ads_insights', 'linkedin_signals'];
const OPERATIONS_DENIED = ['draft_email', 'whatsapp_send', 'ads_insights'];
export function parseStage(value: unknown): RolloutStage { return value === 1 || value === 2 || value === 3 ? value : 0; }
export function classifyActionSurface(actionType: string): 'internal' | 'external' | 'irreversible' {
  const normalized = actionType.replace(/_/g, ' ').toLowerCase();
  if (/\b(refund|delete|wire)\b/.test(normalized)) return 'irreversible';
  if (/\b(send|email|whatsapp|sms|publish|outbound)\b/.test(normalized)) return 'external';
  return 'internal';
}
export function roleAllowsTool(role: string, actionType: string): boolean {
  const r = role.toLowerCase(); const action = actionType.toLowerCase();
  if (r.includes('growth') && GROWTH_DENIED.some((d) => action.includes(d))) return false;
  if ((r.includes('customer') || r.includes('support')) && CUSTOMER_DENIED.some((d) => action.includes(d))) return false;
  if (r.includes('operation') && OPERATIONS_DENIED.some((d) => action.includes(d))) return false;
  return true;
}
export function evaluateEmployeeGate(input: EmployeeGateInput): EmployeeGateVerdict {
  if (!roleAllowsTool(input.employeeRole, input.actionType)) return 'deny_role';
  if (input.killSwitch) return 'shadow';
  const stage = parseStage(input.rolloutStage);
  if (input.reversibility === 'irreversible') return 'escalate';
  switch (stage) {
    case 0: return 'shadow';
    case 1: return classifyActionSurface(input.actionType) === 'internal' ? 'allow' : 'escalate';
    case 2: return classifyActionSurface(input.actionType) === 'external' ? 'escalate' : 'allow';
    case 3: return input.reversibility === 'visible' ? 'escalate' : 'allow';
    default: { const _exhaustive: never = stage; return _exhaustive; }
  }
}
export function missingMetaDefaults(): EmployeeGateInput {
  return { killSwitch: false, rolloutStage: 0, employeeRole: 'customer', actionType: 'observe', reversibility: 'reversible' };
}
