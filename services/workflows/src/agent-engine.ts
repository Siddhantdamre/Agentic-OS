/**
 * Shared type definitions for agent task execution.
 *
 * The runtime agent loop now lives in atomic-agent (external process, own
 * reasoning + tool surface + memory fabric). LangGraph was removed; this
 * module re-exports the task contract from @darex/shared-types.
 */

export type {
  AgentTaskInput,
  AgentTaskResult,
  AgentStepResult,
  CrewMode,
  CrewPlan,
  CrewSpawnResult,
  CrewWorkflowInput,
  CrewWorkflowResult,
} from '@darex/shared-types';
export { MAX_CREW_SPAWN } from '@darex/shared-types';
