/**
 * Ordered DSR delete surface. Each name is deleted with DELETE … WHERE org_id = $1.
 * Missing tables (42P01) count as 0 rows and are still marked done for resume.
 */

/** 023+ employee-state stores. */
export const EMPLOYEE_STATE_TABLES = [
  'agent_decision_ledger_daily',
  'agent_decision_ledger',
  'agent_pending_actions',
  'agent_open_loops',
  'operational_expectations',
  'operational_enquiries',
  'agent_entity_leases',
  'agent_outbound_budget',
  'agent_preference_suppressions',
  'employee_autonomy_rules',
  'employee_authority_policies',
  'conversational_insights',
  'org_employee_metrics_daily',
  'org_runtime_controls',
  'org_backfill_jobs',
  'org_first_observations',
  'employee_roi_metrics',
  'org_cost_ceilings',
  'org_model_spend',
  'outcome_feedback',
] as const;

/** Core org data deleted after employee-state tables (FK-friendly order). */
export const CORE_DELETE_TABLES = [
  'memory_edges',
  'ingestion_jobs',
  'knowledge_sources',
  'org_memory',
  'employee_memory',
  'entity_memory',
  'conversation_memory',
  'fact_conflicts',
  'facts',
  'work_events',
  'work_items',
  'messages',
  'conversations',
  'agent_plans',
  'channel_logs',
  'idempotency_keys',
] as const;

/** Full ordered delete list used by the resumable DSR delete job. */
export const DSR_DELETE_TABLES: readonly string[] = [
  ...EMPLOYEE_STATE_TABLES,
  ...CORE_DELETE_TABLES,
];

export type DsrDeleteProgress = {
  doneTables: string[];
  deleted: Record<string, number>;
  currentTable?: string;
};

export function parseDsrDeleteProgress(raw: unknown): DsrDeleteProgress {
  if (!raw || typeof raw !== 'object') {
    return { doneTables: [], deleted: {} };
  }
  const obj = raw as Record<string, unknown>;
  const doneTables = Array.isArray(obj.doneTables)
    ? obj.doneTables.filter((t): t is string => typeof t === 'string')
    : [];
  const deleted =
    obj.deleted && typeof obj.deleted === 'object' && !Array.isArray(obj.deleted)
      ? (obj.deleted as Record<string, number>)
      : {};
  const currentTable = typeof obj.currentTable === 'string' ? obj.currentTable : undefined;
  return { doneTables, deleted, currentTable };
}

/**
 * Next tables still needing a DELETE pass. Idempotent: re-deleting a cleared
 * table is safe (0 rows) but we skip doneTables so retries resume quickly.
 */
export function remainingDeleteTables(
  allTables: readonly string[],
  progress: DsrDeleteProgress
): string[] {
  const done = new Set(progress.doneTables);
  return allTables.filter((t) => !done.has(t));
}

export function markTableDone(
  progress: DsrDeleteProgress,
  table: string,
  rowCount: number
): DsrDeleteProgress {
  const doneTables = progress.doneTables.includes(table)
    ? progress.doneTables
    : [...progress.doneTables, table];
  return {
    doneTables,
    deleted: { ...progress.deleted, [table]: rowCount },
    currentTable: undefined,
  };
}
