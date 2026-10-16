/**
 * Shared type definitions for agent task execution.
 *
 * The runtime agent loop runs in TrueForge (external process, own
 * reasoning + tool surface + memory fabric) via the MCP bridge.
 * LangGraph was removed; this module re-exports the task contract
 * from @darex/shared-types.
 */

export type {
  AgentTaskInput,
  AgentTaskResult,
  AgentStepResult,
  ApprovalRequest,
  SubagentEvent,
  TurnUsage,
  CrewMode,
  CrewPlan,
  CrewSpawnResult,
  CrewWorkflowInput,
  CrewWorkflowResult,
  FixedCrewMember,
} from '@darex/shared-types';
export { MAX_CREW_SPAWN, planFixedMemberCrew } from '@darex/shared-types';
