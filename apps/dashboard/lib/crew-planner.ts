// Crew planner: LiteLLM JSON assignment of a request to 1–3 employees.
// Bypasses atomic-agent (same hang class as classify). Heuristic fallback
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
}

const DOMAIN_HINTS: DomainHint[] = [
  {
    keys: /\b(ads?|campaign|roas|ctr|meta ads|google ads|ad spend)\b/i,
    tools: ['meta-ads', 'google-ads'],
    roleHints: /\b(ads|media|ops|marcus|marketing)\b/i,
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
  {
    keys: /\b(stripe|invoice|payment|razorpay)\b/i,
    tools: ['stripe', 'razorpay'],
    roleHints: /\b(finance|ops)\b/i,
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
  const byTools = roster.find((emp) => {
    const tools = emp.tool_allowlist.map((t) => t.toLowerCase());
    return domain.tools.some((need) => tools.includes(need));
  });
  if (byTools) return byTools;
  return roster.find((emp) => domain.roleHints.test(`${emp.name} ${emp.role}`)) || null;
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

export function heuristicCrewPlan(message: string, roster: CrewRosterMember[]): CrewPlan {
  const active = roster.filter((e) => !e.status || e.status === 'active');
  const pool = active.length > 0 ? active : roster;
  if (pool.length === 0) {
    return { mode: 'solo', reason: 'No employees in roster', specialists: [] };
  }

  const first = pool[0];
  if (SIMPLE_HINTS.test(message) && wordCount(message) < 8) {
    return soloPlan(first, message, 'Greeting or short question stays solo');
  }

  const picks: CrewRosterMember[] = [];
  const seen = new Set<string>();
  for (const domain of DOMAIN_HINTS) {
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
    return {
      mode: 'crew',
      reason: `Matched ${specialists.length} distinct employee domains`,
      specialists,
    };
  }

  if (picks.length === 1) {
    return soloPlan(picks[0], message, `Routed to ${picks[0].name} by domain match`);
  }

  return soloPlan(first, message, 'Default solo — no multi-domain match');
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
    if (!emp || seen.has(emp.id)) continue;
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
  return fromLlm || fallback;
}

export function parseEmployeeAllowlist(raw: unknown): string[] {
  return parseAllowlist(raw);
}
