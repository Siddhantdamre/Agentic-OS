/**
 * Tracks actively running non-durable plan executions in-memory.
 * Used by /api/ask-ai/execute to prevent duplicate in-flight executions
 * while allowing legitimate reconnects to resume (ASK-B01).
 */

export const activePlanExecutions = new Set<string>();
