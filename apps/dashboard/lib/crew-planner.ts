// Crew planner: LiteLLM JSON assignment of a request to 1–3 employees.
// Bypasses the TrueForge agent loop (same hang class as classify). Heuristic fallback
// when LiteLLM fails. Greetings and short Q&A stay solo.

import { chatCompletion } from './litellm-client';
import type { CrewPlan, CrewRosterMember, CrewSpecialistAssignment } from '@darex/shared-types';
import { MAX_CREW_SPAWN } from '@darex/shared-types';

const SIMPLE_HINTS = new RegExp(
  [
    '^\\s*(hi|hello|hey|yo|good\\s?(morning|afternoon|evening))\\b',
    '\\b(what\\s+is|what\\s+are|explain|define|how\\s+(do|does|can|would)|tell\\s+me|meaning of)\\b',
    '\\b(who\\s+are\\s+you|thanks|thank you|you\\s+are\\s+awesome)\\b',
  ].join('|'),
  'i'
);

interface DomainHint {
  keys: RegExp;
  tools: string[];
  roleHints: RegExp;
  /** When set, this domain is skipped if the predicate matches the message. */
  skipIf?: (message: string) => boolean;
}

/** Refund / return / money-back — Customer Resolution owns these, not Finance. */
export const REFUND_SHAPED_RE =
  /\b(refunds?|chargebacks?|charge[\s-]?backs?|money[\s-]?back|returns?)\b/i;

const DOMAIN_HINTS: DomainHint[] = [
  {
    keys: /\b(ads?|campaign|roas|ctr|meta ads|google ads|ad spend)\b/i,
    tools: ['meta-ads', 'google-ads'],
    roleHints: /\b(marcus|marketing)\b/i,
  },
  {
    keys: /\b(reconcil|dedup|spreadsheet|google sheets|meeting prep|triage)\b/i,
    tools: ['google-sheets'],
    roleHints: /\b(operations)\b/i,
  },
  {
    keys: /\b(lookalike|apollo|buying signal|website visitor)\b/i,
    tools: ['apollo'],
    roleHints: /\b(growth)\b/i,
  },
  {
    keys: /\b(research|cite|citation|notion|drive doc)\b/i,
    tools: ['web_search', 'notion'],
    roleHints: /\b(research)\b/i,
  },
  {
    keys: /\b(calendar|schedule|meeting|availability|ticket|support|sop)\b/i,
    tools: ['google-calendar', 'zendesk', 'intercom'],
    roleHints: /\b(support|emma|ops|customer)\b/i,
  },
  {
    keys: /\b(email|gmail|inbox|hubspot|lead|deal|crm|outreach|sales)\b/i,
    tools: ['gmail', 'hubspot'],
    roleHints: /\b(sales|sarah|sdr|ae)\b/i,
  },
  {
    keys: /\b(github|pull request|repo|code review)\b/i,
    tools: ['github'],
    roleHints: /\b(eng|dev|github)\b/i,
  },
  // Refunds before Finance so stripe|payment in a refund ask never fans out to Finance.
  {
    keys: REFUND_SHAPED_RE,
    tools: ['stripe', 'hubspot', 'zendesk', 'intercom'],
    roleHints: /\bcustomer\s+resolution\b/i,
  },
  {
    keys: /\b(stripe|invoice|payment|razorpay)\b/i,
    tools: ['stripe', 'razorpay'],
    roleHints: /\b(finance)\b/i,
    skipIf: (message) => REFUND_SHAPED_RE.test(message),
  },
];

function parseAllowlist(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function wordCount(message: string): number {
  return message.trim().split(/\s+/).filter(Boolean).length;
}

function pickEmployeeForDomain(roster: CrewRosterMember[], domain: DomainHint): CrewRosterMember | null {
  const byRole = roster.find((emp) => domain.roleHints.test(`${emp.name} ${emp.role}`));
  if (byRole) return byRole;
  const byTools = roster.find((emp) => {
    const tools = emp.tool_allowlist.map((t) => t.toLowerCase());
    return domain.tools.some((need) => tools.includes(need));
  });
  return byTools || null;
}

function soloPlan(employee: CrewRosterMember, task: string, reason: string): CrewPlan {
  return {
    mode: 'solo',
    reason,
    specialists: [
      {
        employeeId: employee.id,
        employeeName: employee.name,
        employeeRole: employee.role,
        task,
      },
    ],
  };
}

function isFinanceSpecialist(
  spec: CrewSpecialistAssignment,
  rosterById: Map<string, CrewRosterMember>,
): boolean {
  const emp = rosterById.get(spec.employeeId);
  const blob = `${emp?.name || spec.employeeName || ''} ${emp?.role || spec.employeeRole || ''}`.toLowerCase();
  return /\bfinance\b/.test(blob);
}

function findCustomerResolution(roster: CrewRosterMember[]): CrewRosterMember | undefined {
  const pool = roster.filter(isActiveCrewMember);
  return (
    pool.find((e) => /\bcustomer\s+resolution\b/i.test(`${e.name} ${e.role}`)) ||
    pool.find((e) => /^customer$/i.test(e.name.trim()))
  );
}

/**
 * Post-plan guard for heuristic and LiteLLM crews: refund / return / money-back
 * never keep Finance, and Customer Resolution must be on the specialist list.
 * Payment links / invoices / charges with no refund words pass through unchanged.
 */
export function enforceRefundCrewOwnership(
  plan: CrewPlan,
  message: string,
  roster: CrewRosterMember[],
): CrewPlan {
  if (!REFUND_SHAPED_RE.test(message)) return plan;

  const rosterById = new Map(roster.map((e) => [e.id, e]));
  const withoutFinance = plan.specialists.filter((s) => !isFinanceSpecialist(s, rosterById));
  const customer = findCustomerResolution(roster);

  const hasCustomer = withoutFinance.some((s) => {
    const emp = rosterById.get(s.employeeId);
    if (emp && customer && emp.id === customer.id) return true;
    return /\bcustomer\s+resolution\b/i.test(`${s.employeeName || ''} ${s.employeeRole || ''}`);
  });

  let specialists = [...withoutFinance];
  if (customer && !hasCustomer) {
    specialists = [
      {
        employeeId: customer.id,
        employeeName: customer.name,
        employeeRole: customer.role,
        task: message,
      },
      ...specialists,
    ];
  }
  specialists = specialists.slice(0, MAX_CREW_SPAWN);

  if (specialists.length === 0 && customer) {
    return soloPlan(customer, message, 'Refund owned by Customer Resolution — Finance removed');
  }
  if (specialists.length === 0) return { ...plan, specialists: [] };

  const stripped = withoutFinance.length < plan.specialists.length || (!hasCustomer && Boolean(customer));
  const mode: CrewPlan['mode'] = specialists.length >= 2 ? 'crew' : 'solo';
  switch (mode) {
    case 'solo':
      return {
        mode,
        reason: stripped
          ? `${plan.reason} (refund → Customer Resolution; Finance removed)`.trim()
          : plan.reason,
        specialists: specialists.slice(0, 1),
      };
    case 'crew':
      return {
        mode,
        reason: stripped
          ? `${plan.reason} (refund → Customer Resolution; Finance removed)`.trim()
          : plan.reason,
        specialists,
      };
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Missing status is treated as active (legacy rows). Explicit non-active is excluded. */
export function isActiveCrewMember(emp: Pick<CrewRosterMember, 'status'>): boolean {
  return !emp.status || emp.status === 'active';
}

/**
 * Drop rows missing id/name before roster build. Callers must not assume
 * output length equals input length — use droppedCount.
 */
export function filterValidEmployeeRows<T extends { id?: string; name?: string }>(
  rows: T[],
): { valid: T[]; droppedCount: number } {
  const valid: T[] = [];
  let droppedCount = 0;
  for (const row of rows) {
    if (!row.id || !row.name) {
      droppedCount += 1;
      continue;
    }
    valid.push(row);
  }
  return { valid, droppedCount };
}

export type ResolvedCrewAssignment = {
  assignment: CrewSpecialistAssignment;
  employee: CrewRosterMember;
};

/**
 * Map plan assignments onto the roster. Unmatched and inactive ids are
 * returned explicitly so callers can log/surface them — never silent drop.
 */
export function resolveCrewAssignments(
  assignments: CrewSpecialistAssignment[],
  roster: CrewRosterMember[],
): {
  resolved: ResolvedCrewAssignment[];
  unmatchedEmployeeIds: string[];
  inactiveEmployeeIds: string[];
} {
  const byId = new Map(roster.map((emp) => [emp.id, emp]));
  const resolved: ResolvedCrewAssignment[] = [];
  const unmatchedEmployeeIds: string[] = [];
  const inactiveEmployeeIds: string[] = [];
  const seen = new Set<string>();

  for (const assignment of assignments) {
    const emp = byId.get(assignment.employeeId);
    if (!emp) {
      unmatchedEmployeeIds.push(assignment.employeeId);
      continue;
    }
    if (!isActiveCrewMember(emp)) {
      inactiveEmployeeIds.push(emp.id);
      continue;
    }
    if (seen.has(emp.id)) continue;
    seen.add(emp.id);
    resolved.push({ assignment, employee: emp });
  }

  return { resolved, unmatchedEmployeeIds, inactiveEmployeeIds };
}

export function heuristicCrewPlan(message: string, roster: CrewRosterMember[]): CrewPlan {
  // Never assign tasks to inactive employees — even as a last-resort pool.
  const pool = roster.filter(isActiveCrewMember);
  if (pool.length === 0) {
    return { mode: 'solo', reason: 'No active employees in roster', specialists: [] };
  }

  const first = pool[0];
  if (SIMPLE_HINTS.test(message) && wordCount(message) < 8) {
    return soloPlan(first, message, 'Greeting or short question stays solo');
  }

  const picks: CrewRosterMember[] = [];
  const seen = new Set<string>();
  for (const domain of DOMAIN_HINTS) {
    if (domain.skipIf?.(message)) continue;
    if (!domain.keys.test(message)) continue;
    const emp = pickEmployeeForDomain(pool, domain);
    if (emp && !seen.has(emp.id)) {
      seen.add(emp.id);
      picks.push(emp);
    }
  }

  if (picks.length >= 2) {
    const specialists: CrewSpecialistAssignment[] = picks.slice(0, MAX_CREW_SPAWN).map((emp) => ({
      employeeId: emp.id,
      employeeName: emp.name,
      employeeRole: emp.role,
      task: message,
    }));
    return enforceRefundCrewOwnership(
      {
        mode: 'crew',
        reason: `Matched ${specialists.length} distinct employee domains`,
        specialists,
      },
      message,
      pool,
    );
  }

  if (picks.length === 1) {
    return enforceRefundCrewOwnership(
      soloPlan(picks[0], message, `Routed to ${picks[0].name} by domain match`),
      message,
      pool,
    );
  }

  return enforceRefundCrewOwnership(
    soloPlan(first, message, 'Default solo — no multi-domain match'),
    message,
    pool,
  );
}

function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateLlmPlan(parsed: unknown, roster: CrewRosterMember[], message: string): CrewPlan | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { mode?: string; reason?: string; specialists?: unknown };
  const byId = new Map(roster.map((e) => [e.id, e]));
  const rawSpecs = Array.isArray(obj.specialists) ? obj.specialists : [];
  const specialists: CrewSpecialistAssignment[] = [];
  const seen = new Set<string>();
  for (const spec of rawSpecs) {
    if (!spec || typeof spec !== 'object') continue;
    const employeeId = String((spec as { employeeId?: string }).employeeId || '');
    const emp = byId.get(employeeId);
    if (!emp || !isActiveCrewMember(emp) || seen.has(emp.id)) continue;
    seen.add(emp.id);
    specialists.push({
      employeeId: emp.id,
      employeeName: emp.name,
      employeeRole: emp.role,
      task: String((spec as { task?: string }).task || message),
    });
    if (specialists.length >= MAX_CREW_SPAWN) break;
  }
  if (specialists.length === 0) return null;

  const mode: CrewPlan['mode'] = specialists.length >= 2 && obj.mode === 'crew' ? 'crew' : 'solo';
  switch (mode) {
    case 'solo':
      return {
        mode,
        reason: String(obj.reason || 'LiteLLM assigned one employee'),
        specialists: specialists.slice(0, 1),
      };
    case 'crew':
      return {
        mode,
        reason: String(obj.reason || 'LiteLLM assigned a crew'),
        specialists,
      };
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}

async function planWithLiteLLM(message: string, roster: CrewRosterMember[]): Promise<CrewPlan | null> {
  const rosterJson = roster.map((e) => ({
    id: e.id,
    name: e.name,
    role: e.role,
    tools: e.tool_allowlist,
  }));
  try {
    const content = await chatCompletion(
      [
        {
          role: 'system',
          content: [
            'You assign work to AI employees. Reply with ONLY JSON, no fences.',
            `Shape: {"mode":"solo"|"crew","reason":"...","specialists":[{"employeeId":"...","task":"..."}]}`,
            `Cap specialists at ${MAX_CREW_SPAWN}. Greetings and single-domain work must be solo.`,
            'Crew only when the request needs two or more distinct roles in parallel.',
            'employeeId must be copied from the roster. Do not invent ids.',
            'Refunds, returns, chargebacks, and money-back requests belong to Customer Resolution — never Finance, even when the message mentions Stripe or payment.',
            'Payment links, invoices, Razorpay collect, and new charges belong to Finance.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Roster:\n${JSON.stringify(rosterJson)}\n\nUser request:\n${message}`,
        },
      ],
      { maxTokens: 400, temperature: 0, timeoutMs: 20000 }
    );
    return validateLlmPlan(extractJsonObject(content), roster, message);
  } catch (err) {
    console.warn('[CrewPlanner] LiteLLM call failed:', (err as Error)?.message);
    return null;
  }
}

export async function planCrew(message: string, roster: CrewRosterMember[]): Promise<CrewPlan> {
  const fallback = heuristicCrewPlan(message, roster);
  const fromLlm = await planWithLiteLLM(message, roster);
  const chosen = fromLlm || fallback;
  return enforceRefundCrewOwnership(chosen, message, roster);
}

export function parseEmployeeAllowlist(raw: unknown): string[] {
  return parseAllowlist(raw);
}
