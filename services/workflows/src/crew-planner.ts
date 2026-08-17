/**
 * Crew planning — decide WHO works on a task, from the org's real roster.
 *
 * Pure module. No Node, pg, or fetch, so it is safe to import from the Temporal
 * workflow isolate (same constraint as crew-contract.ts).
 *
 * WHY
 * `CrewWorkflow` already fans out to specialists and synthesizes their reports,
 * but the roster came from `input.specialists` — the caller hardcoded the team.
 * Decomposition existed separately in the dashboard's plan-generator and was
 * never connected to it. This module is the missing join: given a request and
 * the org's actual employees, choose who should work on what.
 *
 * ── THE SECURITY BOUNDARY ────────────────────────────────────────────────────
 *
 * A model proposes; `validateCrewPlan` disposes. Two invariants make dynamic
 * composition safe, and both are enforced here rather than trusted upstream:
 *
 *   1. AN ASSIGNMENT MAY ONLY NAME AN EXISTING EMPLOYEE.
 *      Anything referencing an unknown id is dropped. A hallucinated
 *      "Legal Specialist" would otherwise arrive with no persona, no owner and
 *      — worst — no defined tool allowlist.
 *
 *   2. TOOL ALLOWLISTS NEVER COME FROM THE MODEL.
 *      They are read from the employee record the id resolves to. The planner
 *      chooses *who acts*, never *what they may touch*. Without this, "plan a
 *      crew" would be a permission-escalation primitive: the model could grant
 *      a sales agent the payments tool by writing it into its own plan.
 *
 * Everything else here is about not wasting money: a crew costs N+1 agent runs,
 * so it must clear a real bar before it beats one competent agent.
 */

import { MAX_CREW_SPAWN } from './crew-contract.js';

/** An employee that may be assigned work. Sourced from the DB, never a model. */
export interface CrewCandidate {
  employeeId: string;
  name: string;
  role: string;
  persona: string;
  /** Authoritative. Copied onto the assignment; model input is ignored. */
  toolAllowlist: string[];
}

/** One specialist assignment after validation. */
export interface CrewAssignment {
  employeeId: string;
  name: string;
  role: string;
  persona: string;
  /** Authoritative allowlist from the employee record. */
  toolAllowlist: string[];
  /** The slice of work this specialist owns. */
  subtask: string;
}

export interface CrewPlan {
  mode: 'solo' | 'crew';
  assignments: CrewAssignment[];
  reason: string;
  /** Assignments discarded during validation, with why. For audit. */
  rejected: Array<{ employeeId: string; reason: string }>;
}

/** Shape we hope the model returns. Every field is treated as untrusted. */
export interface RawCrewPlan {
  assignments?: Array<{
    employeeId?: unknown;
    subtask?: unknown;
    // A model may emit `toolAllowlist` here. It is deliberately IGNORED —
    // see security invariant 2.
    [key: string]: unknown;
  }>;
  reason?: unknown;
}

const MAX_SUBTASK_LENGTH = 400;

/**
 * A crew needs at least this many specialists to be worth it.
 *
 * Below 2 there is nothing to parallelise or cross-check, and the run still
 * pays for a synthesis turn on top — strictly worse than one agent doing it.
 */
export const MIN_CREW_SIZE = 2;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn an untrusted model plan into an executable one.
 *
 * Total function: any malformed input yields a `solo` plan rather than throwing,
 * because a planning failure must degrade to "one agent handles it" — the
 * behaviour before this module existed — not to a failed customer request.
 */
export function validateCrewPlan(raw: RawCrewPlan | null | undefined, candidates: CrewCandidate[]): CrewPlan {
  const rejected: Array<{ employeeId: string; reason: string }> = [];

  if (!raw || !Array.isArray(raw.assignments) || raw.assignments.length === 0) {
    return { mode: 'solo', assignments: [], reason: 'no usable plan returned', rejected };
  }

  const byId = new Map(candidates.map((c) => [c.employeeId, c]));
  const seen = new Set<string>();
  const assignments: CrewAssignment[] = [];

  for (const item of raw.assignments) {
    const employeeId = asString(item?.employeeId);
    const subtask = asString(item?.subtask);

    if (!employeeId) {
      rejected.push({ employeeId: '(missing)', reason: 'no employeeId' });
      continue;
    }

    // INVARIANT 1: must resolve to a real employee in this org.
    const candidate = byId.get(employeeId);
    if (!candidate) {
      rejected.push({ employeeId, reason: 'unknown employee (not on this org roster)' });
      continue;
    }

    if (!subtask) {
      rejected.push({ employeeId, reason: 'no subtask described' });
      continue;
    }

    // One employee cannot hold two slots: duplicate work, doubled cost, and the
    // synthesis step gets two reports that disagree with each other.
    if (seen.has(employeeId)) {
      rejected.push({ employeeId, reason: 'duplicate assignment' });
      continue;
    }

    if (assignments.length >= MAX_CREW_SPAWN) {
      rejected.push({ employeeId, reason: `exceeds MAX_CREW_SPAWN (${MAX_CREW_SPAWN})` });
      continue;
    }

    seen.add(employeeId);
    assignments.push({
      employeeId: candidate.employeeId,
      name: candidate.name,
      role: candidate.role,
      persona: candidate.persona,
      // INVARIANT 2: allowlist from the DB record, never from the model.
      toolAllowlist: [...candidate.toolAllowlist],
      subtask: subtask.slice(0, MAX_SUBTASK_LENGTH),
    });
  }

  if (assignments.length < MIN_CREW_SIZE) {
    return {
      mode: 'solo',
      assignments: [],
      reason:
        assignments.length === 0
          ? 'no valid assignments survived validation'
          : `only ${assignments.length} valid specialist — a crew needs ${MIN_CREW_SIZE}`,
      rejected,
    };
  }

  const modelReason = asString(raw.reason);
  return {
    mode: 'crew',
    assignments,
    reason: modelReason ? modelReason.slice(0, 300) : `${assignments.length} specialists assigned`,
    rejected,
  };
}

/**
 * Prompt for the planning model.
 *
 * Employees are presented as a closed list with explicit ids. The model is told
 * to prefer one specialist — crews are the exception, not the default, because
 * most requests are genuinely single-threaded and a crew triples the cost.
 */
export function buildCrewPlanPrompt(userMessage: string, candidates: CrewCandidate[]): string {
  const roster = candidates.map((c) =>
    [
      `- employeeId: ${c.employeeId}`,
      `  name: ${c.name}`,
      `  role: ${c.role}`,
      `  tools: ${c.toolAllowlist.length > 0 ? c.toolAllowlist.join(', ') : '(none)'}`,
    ].join('\n')
  );

  return [
    'You assign work to AI employees. Decide whether this request needs ONE employee or several.',
    '',
    'Rules:',
    `- Choose employees ONLY from the roster below, by their exact employeeId.`,
    '- Never invent an employee, an id, or a tool.',
    `- Assign at most ${MAX_CREW_SPAWN} employees.`,
    '- Prefer ONE employee. Only use several when the request has genuinely independent',
    '  parts that different specialists own, and that can run in parallel.',
    '- Each assignment must describe a distinct subtask. Never give two employees the same work.',
    '- Match the subtask to the tools that employee actually has.',
    '',
    'Return ONLY JSON:',
    '{"assignments":[{"employeeId":"<id>","subtask":"<what they do>"}],"reason":"<why>"}',
    'For a single employee, return one assignment.',
    '',
    'ROSTER:',
    ...roster,
    '',
    'REQUEST:',
    userMessage.slice(0, 2000),
  ].join('\n');
}

/**
 * Extract a JSON object from a model response.
 *
 * Mirrors critic-check's `extractJsonObject`: models wrap JSON in prose or
 * fences regardless of instructions.
 */
export function extractPlanJson(raw: string): RawCrewPlan | null {
  const trimmed = (raw || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as RawCrewPlan;
  } catch {
    return null;
  }
}
