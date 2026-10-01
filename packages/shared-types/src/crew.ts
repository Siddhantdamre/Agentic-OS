/** Multi-employee crew contracts. Fan-out is Temporal child workflows, not a second agent framework. */

import type { AgentTaskInput, AgentTaskResult } from './agent.js';

/** Product + Ask AI Team mode: at most 3 employees per message. */
export const MAX_CREW_SPAWN = 3;

export type CrewMode = 'solo' | 'crew';

export interface CrewRosterMember {
  id: string;
  name: string;
  role: string;
  persona: string;
  tool_allowlist: string[];
  status?: string;
}

/**
 * One employee the user picked in Ask AI Team mode.
 * Allowlist is that employee's own tools; the caller merges core tools +
 * connected channels — never the org-wide union of every employee.
 */
export interface FixedCrewMember {
  id: string;
  name: string;
  role: string;
  tool_allowlist: string[];
  persona?: string;
}

export interface CrewSpecialistAssignment {
  employeeId: string;
  employeeName: string;
  employeeRole: string;
  task: string;
  dependsOn?: number[];
}

export interface CrewPlan {
  mode: CrewMode;
  reason: string;
  specialists: CrewSpecialistAssignment[];
}

export interface CrewSpawnResult {
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  task: string;
  result: AgentTaskResult;
}

export interface CrewWorkflowInput {
  orgId: string;
  conversationId?: string;
  channelId?: string;
  userMessage: string;
  idempotencyKey?: string;
  reason?: string;
  manager: AgentTaskInput;
  specialists: AgentTaskInput[];
  /**
   * When true, `specialists` are the user-selected Team roster.
   * Do not replace them with planCrew / domain auto-pick. Cap still applies.
   * Greetings still run every selected member (no collapse to a solo executive).
   */
  fixedMembers?: boolean;
}

export interface CrewWorkflowResult {
  mode: CrewMode;
  success: boolean;
  replyMessage: string;
  reason?: string;
  spawned: CrewSpawnResult[];
  synthesis: AgentTaskResult;
  usedTools: string[];
}

/**
 * Build a crew plan from a user-selected Team without domain auto-pick.
 * Keeps every member (after cap). Does not collapse greetings to solo.
 */
export function planFixedMemberCrew(
  members: Array<Pick<FixedCrewMember, 'id' | 'name' | 'role'>>,
  userMessage: string,
): CrewPlan {
  const specialists: CrewSpecialistAssignment[] = members.slice(0, MAX_CREW_SPAWN).map((m) => ({
    employeeId: m.id,
    employeeName: m.name,
    employeeRole: m.role,
    task: userMessage,
  }));
  const mode: CrewMode = specialists.length >= 2 ? 'crew' : 'solo';
  switch (mode) {
    case 'solo':
      return {
        mode,
        reason: 'Fixed Team mode — user-selected employees',
        specialists,
      };
    case 'crew':
      return {
        mode,
        reason: 'Fixed Team mode — user-selected employees',
        specialists,
      };
    default: {
      const _never: never = mode;
      return _never;
    }
  }
}
