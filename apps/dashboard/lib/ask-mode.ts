/**
 * Ask AI employee-mode resolution (server). Pure helpers — org membership is
 * injected so unit tests never need a live DB. Picking never widens the
 * allowlist: locked turns use only that employee's tools + core + connected.
 */

import { parseEmployeeMentions } from './employee-mentions';
import type { PlanStep } from '@darex/shared-types';
import type { CrewPlan, CrewRosterMember, CrewSpecialistAssignment } from '@darex/shared-types';

/** Product team lock max. Shared MAX_CREW_SPAWN may still differ until M3. */
export const ASK_TEAM_MAX = 3;

export type AskMode = 'auto' | 'single' | 'team';

export interface AskRouting {
  mode: AskMode;
  employeeIds: string[];
  employeeNames: string[];
  reason: string;
  overriddenByMention: boolean;
  fallbackNotice?: string;
}

export interface OrgEmployeeRow {
  id: string;
  name: string;
  role?: string;
  status?: string;
  persona?: unknown;
  tool_allowlist?: unknown;
  archived_at?: string | null;
}

export interface AskModeSelection {
  /** Mode persisted on the conversation / user prefs (mention does not change this). */
  persistMode: AskMode;
  persistEmployeeIds: string[];
  /** Effective routing for THIS turn after mention / fallback. */
  turnMode: AskMode;
  turnEmployeeIds: string[];
  turnEmployees: OrgEmployeeRow[];
  routing: AskRouting;
}

export type AskModeResolveResult =
  | { ok: true; selection: AskModeSelection }
  | { ok: false; error: string; status: 400 };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAskMode(value: unknown): value is AskMode {
  return value === 'auto' || value === 'single' || value === 'team';
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isActiveEmployee(emp: Pick<OrgEmployeeRow, 'status' | 'archived_at'>): boolean {
  if (emp.archived_at) return false;
  return !emp.status || emp.status === 'active';
}

/** Dedupe preserving first-seen order. */
export function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/**
 * Parse optional body.mode / body.employeeIds.
 * Omitted mode means caller should fall back to conversation / last choice.
 */
export function parseAskModeBody(body: Record<string, unknown> | null | undefined): {
  mode: AskMode | undefined;
  employeeIds: string[] | undefined;
  parseError?: string;
} {
  if (!body || typeof body !== 'object') return { mode: undefined, employeeIds: undefined };

  let mode: AskMode | undefined;
  if (body.mode !== undefined && body.mode !== null) {
    // body.mode === 'plan' is an existing Ask AI plan-request flag — not an employee mode.
    if (body.mode === 'plan') {
      mode = undefined;
    } else if (!isAskMode(body.mode)) {
      return { mode: undefined, employeeIds: undefined, parseError: 'mode must be auto, single, or team' };
    } else {
      mode = body.mode;
    }
  }

  let employeeIds: string[] | undefined;
  if (body.employeeIds !== undefined && body.employeeIds !== null) {
    if (!Array.isArray(body.employeeIds)) {
      return { mode, employeeIds: undefined, parseError: 'employeeIds must be an array of UUIDs' };
    }
    employeeIds = body.employeeIds.map((id) => String(id));
  }

  return { mode, employeeIds };
}

export interface ResolveAskModeArgs {
  bodyMode?: AskMode;
  bodyEmployeeIds?: string[];
  /** Saved on the conversation row (defaults auto + []). */
  conversationMode: AskMode;
  conversationEmployeeIds: string[];
  /** Per-user last choice; used only when body omits mode and conversation is still default. */
  lastChoiceMode: AskMode;
  lastChoiceEmployeeIds: string[];
  /** True when conversation still has default auto + empty ids (brand-new or never set). */
  conversationIsUnset: boolean;
  /** All employees in the session org (active + paused). Lookup is by id only — never trust body org. */
  orgEmployees: OrgEmployeeRow[];
  messageText: string;
}

function findOrgEmployee(orgEmployees: OrgEmployeeRow[], id: string): OrgEmployeeRow | undefined {
  const needle = id.toLowerCase();
  return orgEmployees.find((e) => e.id.toLowerCase() === needle);
}

function namesFor(employees: OrgEmployeeRow[]): string[] {
  return employees.map((e) => e.name);
}

function lockedReason(employees: OrgEmployeeRow[], mode: AskMode): string {
  if (mode === 'single' && employees[0]) return `Locked to ${employees[0].name}`;
  if (mode === 'team') return `Team: ${employees.map((e) => e.name).join(', ')}`;
  return 'Auto routing';
}

/**
 * Validate requested ids against the session-org roster.
 * Unknown / other-org (not in injected roster) → 400 unless previously saved on the conversation.
 * Paused / archived → fallback to auto (never 400, never run as that employee).
 */
export function validateEmployeeSelection(args: {
  mode: AskMode;
  employeeIds: string[];
  orgEmployees: OrgEmployeeRow[];
  previouslySavedIds: string[];
}):
  | { ok: true; mode: AskMode; employees: OrgEmployeeRow[]; fallbackNotice?: string }
  | { ok: false; error: string } {
  const { mode, orgEmployees, previouslySavedIds } = args;

  if (mode === 'auto') {
    return { ok: true, mode: 'auto', employees: [] };
  }

  const ids = dedupeIds(args.employeeIds);
  for (const id of ids) {
    if (!isUuid(id)) {
      return { ok: false, error: `employeeIds must be UUIDs (invalid: ${id})` };
    }
  }

  if (mode === 'single') {
    if (ids.length !== 1) {
      return { ok: false, error: 'single mode requires exactly 1 employeeId' };
    }
  } else if (mode === 'team') {
    if (ids.length < 1 || ids.length > ASK_TEAM_MAX) {
      return {
        ok: false,
        error: `team mode requires 1 to ${ASK_TEAM_MAX} employeeIds (got ${ids.length} after dedupe)`,
      };
    }
  } else {
    const _exhaustive: never = mode;
    return _exhaustive;
  }

  const savedSet = new Set(previouslySavedIds.map((id) => id.toLowerCase()));
  const resolved: OrgEmployeeRow[] = [];
  let fallbackNotice: string | undefined;

  for (const id of ids) {
    const emp = findOrgEmployee(orgEmployees, id);
    if (!emp) {
      if (savedSet.has(id.toLowerCase())) {
        fallbackNotice =
          fallbackNotice ||
          'Selected employee is no longer available; falling back to Auto.';
        return { ok: true, mode: 'auto', employees: [], fallbackNotice };
      }
      return {
        ok: false,
        error: `Unknown employeeId (not in this org): ${id}`,
      };
    }
    if (!isActiveEmployee(emp)) {
      fallbackNotice = `${emp.name} is not active; falling back to Auto.`;
      return { ok: true, mode: 'auto', employees: [], fallbackNotice };
    }
    resolved.push(emp);
  }

  return { ok: true, mode, employees: resolved, fallbackNotice };
}

export function resolveAskMode(args: ResolveAskModeArgs): AskModeResolveResult {
  const previouslySavedIds = args.conversationEmployeeIds || [];

  // Resolve persist intent: body wins; else conversation; else last choice on unset chat; else auto.
  let persistMode: AskMode;
  let persistIds: string[];

  if (args.bodyMode !== undefined) {
    persistMode = args.bodyMode;
    persistIds =
      persistMode === 'auto'
        ? []
        : Array.isArray(args.bodyEmployeeIds)
          ? args.bodyEmployeeIds
          : [];
  } else if (!args.conversationIsUnset) {
    persistMode = args.conversationMode;
    persistIds = args.conversationEmployeeIds || [];
  } else if (args.lastChoiceMode && args.lastChoiceMode !== 'auto') {
    persistMode = args.lastChoiceMode;
    persistIds = args.lastChoiceEmployeeIds || [];
  } else {
    persistMode = 'auto';
    persistIds = [];
  }

  if (persistMode === 'auto') {
    persistIds = [];
  }

  const validated = validateEmployeeSelection({
    mode: persistMode,
    employeeIds: persistIds,
    orgEmployees: args.orgEmployees,
    previouslySavedIds,
  });
  if (!validated.ok) {
    return { ok: false, error: validated.error, status: 400 };
  }

  let turnMode: AskMode = validated.mode;
  let turnEmployees: OrgEmployeeRow[] = validated.employees;
  let fallbackNotice = validated.fallbackNotice;
  let overriddenByMention = false;

  // Persist what the user chose (before mention). If we fell back, persist auto.
  const finalPersistMode: AskMode = validated.mode;
  const finalPersistIds =
    finalPersistMode === 'auto' ? [] : validated.employees.map((e) => e.id);

  // @Name overrides mode for THIS message only.
  const mention = parseEmployeeMentions(
    args.messageText,
    args.orgEmployees.map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      status: isActiveEmployee(e) ? 'active' : 'paused',
    })),
  );
  if (mention.mode === 'mention' && mention.locked?.id) {
    const mentioned = findOrgEmployee(args.orgEmployees, mention.locked.id);
    if (mentioned && isActiveEmployee(mentioned)) {
      turnMode = 'single';
      turnEmployees = [mentioned];
      overriddenByMention = true;
      fallbackNotice = undefined;
    }
    // Inactive / unknown mention: ignore and keep mode (parseEmployeeMentions already skips inactive).
  }

  const routing: AskRouting = {
    mode: turnMode,
    employeeIds: turnEmployees.map((e) => e.id),
    employeeNames: namesFor(turnEmployees),
    reason: lockedReason(turnEmployees, turnMode),
    overriddenByMention,
    ...(fallbackNotice ? { fallbackNotice } : {}),
  };

  return {
    ok: true,
    selection: {
      persistMode: finalPersistMode,
      persistEmployeeIds: finalPersistIds,
      turnMode,
      turnEmployeeIds: turnEmployees.map((e) => e.id),
      turnEmployees,
      routing,
    },
  };
}

/** Reason for auto domain routing (keeps existing router text when present). */
export function autoRoutingReason(employeeName: string | undefined, routerReason: string | undefined): string {
  if (employeeName && routerReason) {
    if (/^name lock:/i.test(routerReason)) return `Locked to ${employeeName}`;
    if (/keyword|domain|routed/i.test(routerReason) || routerReason.includes(':')) {
      return routerReason.startsWith('Routed')
        ? routerReason
        : `Routed to ${employeeName}: ${routerReason}`;
    }
    return `Routed to ${employeeName}: ${routerReason}`;
  }
  if (employeeName) return `Routed to ${employeeName}`;
  return 'Auto — DareX Executive';
}

export function withAutoRoutingReason(
  routing: AskRouting,
  employeeName: string | undefined,
  routerReason: string | undefined,
): AskRouting {
  if (routing.mode !== 'auto' || routing.overriddenByMention) return routing;
  return { ...routing, reason: autoRoutingReason(employeeName, routerReason) };
}

/** Fixed team crew — do not auto-plan membership. Cap ASK_TEAM_MAX. */
export function fixedTeamCrewPlan(
  message: string,
  employees: Array<Pick<OrgEmployeeRow, 'id' | 'name' | 'role'>>,
): CrewPlan {
  const specialists: CrewSpecialistAssignment[] = employees.slice(0, ASK_TEAM_MAX).map((emp) => ({
    employeeId: emp.id,
    employeeName: emp.name,
    employeeRole: emp.role || '',
    task: message,
  }));
  return {
    mode: specialists.length >= 2 ? 'crew' : 'solo',
    reason: `Team: ${specialists.map((s) => s.employeeName).join(', ')}`,
    specialists,
  };
}

export type PlanStepWithEmployee = PlanStep & {
  employeeId?: string;
  employeeName?: string;
  employeeRole?: string;
};

/**
 * Auto-mode plans still run as one employee (ASK-S02): the routed employee,
 * else the Executive, else the first active employee. Null only when the org
 * has no active employee — those steps are refused at execute time.
 */
export function autoPlanEmployee(
  employees: OrgEmployeeRow[],
  routedEmployeeId: string | null | undefined,
): OrgEmployeeRow | null {
  const active = employees.filter((e) => (e.status || 'active') === 'active' && !e.archived_at);
  if (routedEmployeeId) {
    const routed = active.find((e) => e.id === routedEmployeeId);
    if (routed) return routed;
  }
  return active.find((e) => /\bexecutive\b/i.test(String(e.role || ''))) || active[0] || null;
}

/** Stamp plan steps for single/team. Auto leaves steps unchanged. */
export function stampPlanStepsForMode(
  steps: PlanStep[],
  turnMode: AskMode,
  employees: OrgEmployeeRow[],
): PlanStepWithEmployee[] {
  if (turnMode === 'auto' || employees.length === 0) {
    return steps.map((s) => ({ ...s }));
  }
  if (turnMode === 'single') {
    const emp = employees[0];
    return steps.map((s) => ({
      ...s,
      employeeId: emp.id,
      employeeName: emp.name,
      employeeRole: emp.role || '',
    }));
  }
  // team: assign by tool allowlist match, else round-robin across selected members only.
  let rr = 0;
  return steps.map((s) => {
    const tool = String(s.tool || '').toLowerCase();
    const byTool = employees.find((emp) => {
      const list = Array.isArray(emp.tool_allowlist)
        ? emp.tool_allowlist.map((t) => String(t).toLowerCase())
        : [];
      return list.some((t) => t === tool || t.replace(/_/g, '-') === tool.replace(/_/g, '-'));
    });
    const emp = byTool || employees[rr % employees.length];
    rr += 1;
    return {
      ...s,
      employeeId: emp.id,
      employeeName: emp.name,
      employeeRole: emp.role || '',
    };
  });
}

/** Restrict a crew roster to the locked team members (active only). */
export function rosterForLockedTeam(
  roster: CrewRosterMember[],
  employeeIds: string[],
): CrewRosterMember[] {
  const want = new Set(employeeIds.map((id) => id.toLowerCase()));
  return roster.filter((r) => want.has(r.id.toLowerCase()));
}
