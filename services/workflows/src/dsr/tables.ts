/**
 * Ordered DSR delete surface. Each name is deleted with DELETE … WHERE org_id = $1.
 * Missing tables (42P01) count as 0 rows and are still marked done for resume.
 */

/** 023+ employee-state stores. */
export const EMPLOYEE_STATE_TABLES = [
  'agent_decision_ledger_daily',
  'agent_shadow_reviews',
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
  'org_autonomy_stage_events',
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

/**
 * Customer and derived data outside the memory/work tables (SEC-C01,
 * MEM-E01). Children before parents; every FK onto these is SET NULL or
 * CASCADE, so the order is tidiness, not a requirement.
 */
export const CUSTOMER_DATA_TABLES = [
  'memory_revisions',
  'sync_cursors',
  'entity_identifiers',
  'entities',
  'agent_sentiment_history',
  'ambiguous_duplicate_reviews',
  'ask_ai_feedback',
  'conversation_presence',
  'insight_action_runs',
  'tool_invocations',
  'failed_webhooks',
  'org_notification_log',
  'lead_intent_signals',
  'visitor_company_intent',
  'growth_scout_leads',
  'growth_meeting_dossiers',
  'growth_reply_classifications',
  'growth_pipeline_attribution',
  're_showings',
  're_inquiries',
  're_listing_media',
  're_listing_price_history',
  're_listings',
  'pm_charges',
  'pm_leases',
  'org_dues',
] as const;

/**
 * Org tables a DSR delete keeps, with the reason. The org stays a working
 * account after the delete, so its users, configuration and legal records
 * remain. Whether any of these should also go is a product/legal decision
 * (SEC-C01); `tables.test.ts` fails when an org_id table is in neither list.
 */
export const DSR_RETAINED_TABLES: Readonly<Record<string, string>> = {
  users: 'account: sign-in identities',
  organization_memberships: 'account: who belongs to the org',
  org_invites: 'account: pending invitations',
  web_push_subscriptions: 'account: members\' notification devices',
  ask_ai_user_mode_prefs: 'account: member UI preference',
  ai_employees: 'config: the org\'s employees',
  agent_activity_health: 'operations: activity names, timestamps and counts, error text cleaned of e-mail addresses and long numbers; no personal data',
  employee_skills: 'config',
  org_skills: 'config',
  org_packs: 'config',
  org_preferences: 'config',
  org_onboarding: 'config',
  org_plan_overrides: 'config: billing caps',
  org_playbook_promotions: 'config',
  growth_icp_profiles: 'config: ideal-customer profile',
  outbound_domain_locks: 'config: send throttling',
  channels: 'config: connected channels (tokens sealed)',
  org_connectors: 'config: connector registry',
  org_sql_connections: 'config: database connections',
  chatwoot_inbox_map: 'config',
  gcal_calendar_watches: 'config: calendar push channels',
  widget_embed_tokens: 'config: website widget',
  audit_events: 'legal: append-only audit trail',
  billing_audit_log: 'legal: billing records',
  billing_invoices: 'legal: billing records',
  billing_meters: 'legal: billing records',
  billing_subscriptions: 'legal: billing records',
  billing_webhook_events: 'legal: billing records',
  dsr_requests: 'legal: proof the request was handled',
};

/** Full ordered delete list used by the resumable DSR delete job. */
export const DSR_DELETE_TABLES: readonly string[] = [
  ...EMPLOYEE_STATE_TABLES,
  ...CUSTOMER_DATA_TABLES,
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
