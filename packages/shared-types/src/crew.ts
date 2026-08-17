/** Multi-employee crew contracts. Fan-out is Temporal child workflows, not a second agent framework. */

import type { AgentTaskInput, AgentTaskResult } from './agent.js';

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
