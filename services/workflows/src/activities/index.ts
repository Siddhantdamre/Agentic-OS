import { ApplicationFailure, Context } from '@temporalio/activity';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { claimIdempotent, readIdempotent, sideEffectKey, withOrgClient, writeIdempotent } from '../db.js';
import { runAutonomousAgentDirect } from '../agent-client.js';
import { toRetrieveActivityResult } from '../memory/retrieve.js';
import { retrieveForEmployee } from '../memory/employee-retrieve.js';
import type { RetrieveMemoryActivityResult } from '../memory/retrieve.js';
import { enqueueEmbedJobFromWorker } from './embed.js';
import { isAllowedWriteBack, type WriteBackEvent } from '../memory/writeback-policy.js';
import { criticCheck as runCriticCheck } from './critic-check.js';
import {
  mergeRoutedForCaller,
  personaText,
  route,
  type RouteEmployee,
} from '../route-employee.js';
import { memoryWriteBackActivity as runMemoryWriteBack } from './memory-writeback.js';
import { evaluateConfidenceGate, ESCALATION_HOLDING_REPLY } from '../customer/confidence-gate.js';
import { ragTopSimilarity } from '../memory/retrieve.js';
import {
  attachDecisionCardActivity,
  logCustomerLedgerActivity,
  persistOperationalStateActivity,
} from './customer.js';

export { memoryWriteBackActivity } from './memory-writeback.js';

export { assertCrewSpendAllowedActivity } from './crew-budget.js';

export { redactForEmbedActivity } from './redact.js';
export { embedIngestionJobActivity, embedQueuedJobsActivity } from './embed.js';
export { ingestFileActivity, syncConnectorActivity } from './ingest-file.js';
export { countDueSweepActivity, nowIsoActivity } from './sweeps.js';
export {
  sweepOrgActiveActivity,
  claimSweepRunActivity,
  expirePendingDecisionsActivity,
  breachWorkItemSlaActivity,
} from './sweep-governance.js';
export { evaluateCriticDraft, KNOWN_BAD_FAIR_HOUSING_DRAFT } from './critic-check.js';
export {
  persistOperationalStateActivity,
  logCustomerLedgerActivity,
  attachDecisionCardActivity,
  extractObligationActivity,
  clusterConversationalInsightsActivity,
  listKnowledgeGapClustersActivity,
  rollupDecisionLedgerActivity,
} from './customer.js';
export {
  guardedSendActivity,
  recordRoiActivity,
  inQuietHours,
  consumeOutboundBudget,
} from './guarded-send.js';
export { attachWorkItemCardActivity, appendCardEventActivity } from './work-item-card.js';
export {
  dueLoopsActivity,
  acquireLeaseActivity,
  releaseLeaseActivity,
  handleDueLoopActivity,
  runMorningCheckActivity,
  runStuckWorkActivity,
  deliverBriefActivity,
  registerExpectationActivity,
  checkCustomerHealthActivity,
  sendCheckInActivity,
} from './open-loop-sweep.js';
export {
  loadApprovedPlanActivity,
  updateAgentPlanActivity,
  executePlanStepActivity,
  queryBriefingMetricsActivity,
  listNeedsAttentionActivity,
  narrateBriefingActivity,
  persistBriefingActivity,
  msUntilNextHourActivity,
  getOrgTimeZoneActivity,
  listStaleConversationsActivity,
  markStaleNeedsAttentionActivity,
  nurtureGateActivity,
  sendNurtureMessageActivity,
  queryInsightMetricActivity,
  persistInsightActionActivity,
} from './orchestration.js';
export {
  installPackActivity,
  uninstallPackActivity,
  bookShowingActivity,
  rentReminderActivity,
} from './packs.js';
export { sendShowingReminderActivity } from './showing-reminders.js';
export {
  loadOrBuildIcpActivity,
  searchLookalikeCandidatesActivity,
  pollSignalsActivity,
  persistSignalsActivity,
  loadPreferencesActivity,
  rankCandidatesActivity,
  createOpportunityActivity,
  synthesizePreferencesActivity,
  listDormantLeadsActivity,
  runGrowthWatchActivity,
  recordGrowthRoiActivity,
  runMarketScoutActivity,
  compileMeetingDossiersActivity,
  classifyInboundRepliesActivity,
} from './growth.js';
export { auditReconciliationActivity } from './reconciliation.js';
export { auditMeetingPrepActivity, auditCalendarDeadlocksActivity } from './meeting-prep.js';
export { runRepFollowUpSlaActivity } from './rep-followup-sla.js';
export { balanceWorkloadActivity } from './workload-balancer.js';
export { checkContactDuplicateActivity } from './dedup.js';
export { backfillContactFieldsActivity } from './enrichment.js';
export {
  runDsrDeleteActivity,
  runDsrExportActivity,
  markDsrRequestFailedActivity,
} from './dsr.js';


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WorkItemChannel = 'whatsapp' | 'chatwoot' | 'inbox' | 'ask_ai' | 'unknown';
type WorkItemStatus = 'open' | 'in_progress' | 'waiting_approval' | 'needs_attention' | 'done' | 'cancelled';
type WorkItemType = 'conversation';
type WorkEventKind =
  | 'inbound_received'
  | 'memory_retrieved'
  | 'employee_routed'
  | 'agent_started'
  | 'agent_replied'
  | 'agent_failed'
  | 'needs_attention'
  | 'memory_writeback'
  | 'embed_enqueued'
  | 'confirm_requested'
  | 'confirm_approved'
  | 'confirm_rejected'
  | 'critic_blocked';

function workflowIdempotencyKey(suffix: string): string | undefined {
  try {
    const info = Context.current().info;
    const wfId = info.workflowExecution.workflowId;
    if (!wfId) return undefined;
    return `wf:${wfId}:${suffix}`;
  } catch {
    return undefined;
  }
}

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

/**
 * RT-B03: Temporal retries this activity only when the previous attempt timed
 * out or its worker died, so a retry can find the first attempt's tools
 * (send/charge) already dispatched, or still running. The key is per activity
 * execution (run id + activity id), so retries share it and the workflow's
 * own follow-up turns do not.
 */
export function agentTurnClaimKey(): string | undefined {
  try {
    const info = Context.current().info;
    const { workflowId, runId } = info.workflowExecution;
    if (!workflowId || !runId || !info.activityId) return undefined;
    return `wf:${workflowId}:${runId}:agent-turn:${info.activityId}`;
  } catch {
    return undefined;
  }
}

export const TURN_RETRY_HELD_ERROR = 'turn_retry_held';

/** Result for a retry whose earlier attempt never finished: hand to a human. */
export function turnRetryHeldResult(input: AgentTaskInput): AgentTaskResult {
  const isCustomerInbound = Boolean(
    input.customerIdentifier || (input.employeeRole && /customer/i.test(input.employeeRole))
  );
  return {
    success: false,
    replyMessage: isCustomerInbound
      ? ESCALATION_HOLDING_REPLY
      : 'This request timed out partway through, so I did not run it again. ' +
        'Check whether any message, charge or update already went out before asking again.',
    executedSteps: [
      { step: 1, action: 'Agent Turn', result: 'Earlier attempt did not finish; not retried so no tool runs twice' },
    ],
    usedTools: [],
    error: TURN_RETRY_HELD_ERROR,
    retryable: false,
    isDone: true,
    forceEscalate: true,
  };
}

export interface TurnClaimStore {
  claim(orgId: string, key: string): Promise<{ claimed: boolean; cached: AgentTaskResult | null }>;
  write(orgId: string, key: string, result: AgentTaskResult): Promise<void>;
}

const dbTurnClaimStore: TurnClaimStore = {
  claim: (orgId, key) => claimIdempotent<AgentTaskResult>(orgId, key),
  write: (orgId, key, result) => writeIdempotent(orgId, key, result),
};

/** Runs `run` at most once per claim key; see `agentTurnClaimKey`. */
export async function runGuardedAgentTurn(
  input: AgentTaskInput,
  claimKey: string | undefined,
  run: (input: AgentTaskInput) => Promise<AgentTaskResult>,
  store: TurnClaimStore = dbTurnClaimStore
): Promise<AgentTaskResult> {
  let claimed = false;
  if (claimKey && input.orgId) {
    try {
      const claim = await store.claim(input.orgId, claimKey);
      if (!claim.claimed) {
        if (claim.cached) return claim.cached;
        console.warn(`[Temporal Activity] runAgentTurn retry held, earlier attempt unfinished: ${claimKey}`);
        return turnRetryHeldResult(input);
      }
      claimed = true;
    } catch (err) {
      // Without idempotency_keys the guard cannot exist; any other error is
      // thrown so Temporal retries the claim rather than running unguarded.
      // Checks the SQLSTATE only: isUndefinedTable also matches any message
      // with "does not exist" (a missing role or database).
      if ((err as { code?: string } | null)?.code !== '42P01') throw err;
      console.warn('[Temporal Activity] idempotency_keys missing; agent turn runs without retry guard');
    }
  }

  const result = await run(input);

  if (claimed && claimKey) {
    try {
      await store.write(input.orgId, claimKey, result);
    } catch (err) {
      // A retry then sees an unfinished claim and holds, the safe direction.
      console.error('[Temporal Activity] failed to record agent turn result:', err instanceof Error ? err.message : err);
    }
  }
  return result;
}

export async function runAgentTurnActivity(input: AgentTaskInput): Promise<AgentTaskResult> {
  return runGuardedAgentTurn(input, agentTurnClaimKey(), runAgentTurnOnce);
}

async function runAgentTurnOnce(input: AgentTaskInput): Promise<AgentTaskResult> {
  try {
    let priorMessages: { role: string; content: string }[] = [];
    if (input.conversationId) {
      try {
        priorMessages = await withOrgClient(input.orgId, async (client) => {
          const res = await client.query(
            `SELECT role, content FROM (
               SELECT role, content, created_at
               FROM messages
               WHERE org_id = $1 AND conversation_id = $2
               ORDER BY created_at DESC
               LIMIT 10
             ) sub ORDER BY created_at ASC`,
            [input.orgId, input.conversationId]
          );
          return res.rows.map((r) => ({ role: r.role, content: r.content }));
        });
      } catch (e) {
        console.error('Failed to load prior messages', e);
      }
    }
    let retrievedMemory;
    try {
      retrievedMemory = await retrieveForEmployee({
        orgId: input.orgId,
        query: input.userMessage,
        employeeId: input.employeeId,
        conversationId: input.conversationId,
        employeeRole: input.employeeRole,
        customerIdentifier: input.customerIdentifier,
      });
    } catch {
      retrievedMemory = { orgId: input.orgId, citations: [], emptyIndex: true };
    }
    const isCustomerInbound = Boolean(
      input.customerIdentifier ||
      (input.employeeRole && /customer/i.test(input.employeeRole))
    );
    const toolHit = Array.isArray(input.priorToolResults) && input.priorToolResults.length > 0;
    const gate = isCustomerInbound
      ? evaluateConfidenceGate({ topSimilarity: ragTopSimilarity(retrievedMemory), toolHit })
      : { allow: true, reason: 'ok' as const, topSimilarity: ragTopSimilarity(retrievedMemory) };

    if (input.conversationId && isCustomerInbound) {
      await persistOperationalStateActivity({
        orgId: input.orgId,
        conversationId: input.conversationId,
        userMessage: input.userMessage,
        customerIdentifier: input.customerIdentifier,
        forceEscalate: input.forceEscalate || !gate.allow,
      });
    }
    if (!gate.allow || input.forceEscalate) {
      const validWorkItemId = input.sessionKey && UUID_RE.test(input.sessionKey) ? input.sessionKey : undefined;
      if (validWorkItemId) {
        await attachDecisionCardActivity({
          orgId: input.orgId,
          workItemId: validWorkItemId,
          customer: input.customerIdentifier || input.conversationId || 'customer',
          situation: input.userMessage.slice(0, 280),
        });
      }
      await logCustomerLedgerActivity({
        orgId: input.orgId,
        employeeRole: input.employeeRole,
        employeeId: input.employeeId,
        actionConsidered: 'customer_reply',
        decision: 'suppressed',
        reasonCode: gate.reason === 'low_rag_no_tool' ? 'low_rag_no_tool' : 'confidence_below_threshold',
        reasonSummary: 'Low RAG similarity and no tool hit — no external guess',
        confidence: gate.topSimilarity,
        workItemId: validWorkItemId,
        context: { conversationId: input.conversationId, question: input.userMessage.slice(0, 500) },
      });
      return {
        success: true,
        replyMessage: ESCALATION_HOLDING_REPLY,
        executedSteps: [{ step: 1, action: 'Confidence gate', result: gate.reason }],
        usedTools: [],
        isDone: true,
        forceEscalate: true,
        confidenceScore: gate.topSimilarity,
      };
    }
    return await runAutonomousAgentDirect(input, { priorMessages, retrievedMemory });
  } catch (err: any) {
    console.error('[Temporal Activity] runAgentTurn failed:', err.message);
    return {
      success: false,
      replyMessage: 'I encountered an issue processing your request. Please try again.',
      executedSteps: [
        { step: 1, action: 'Agent Turn', result: `Failed: ${err.message}` },
      ],
      usedTools: [],
      error: err.message,
      retryable: /timeout|timed out|abort/i.test(String(err.message || '')),
      isDone: true,
    };
  }
}

export async function saveMessageActivity(params: {
  orgId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: any;
  idempotencyKey?: string;
}): Promise<{ messageId: string }> {
  const key = params.idempotencyKey || workflowIdempotencyKey(`save:${params.role}:${params.conversationId}`);
  const cached = await readIdempotent<{ messageId: string }>(params.orgId, key);
  if (cached?.messageId) return cached;

  const saved = await withOrgClient(params.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [params.orgId, params.conversationId, params.role, params.content, JSON.stringify(params.toolCalls || [])]
    );
    return { messageId: res.rows[0].id as string };
  });

  await writeIdempotent(params.orgId, key, saved);
  return saved;
}

export async function logChannelActivity(params: {
  orgId: string;
  channelId?: string;
  logType: string;
  payload: any;
  idempotencyKey?: string;
}): Promise<{ logId: string }> {
  const key = params.idempotencyKey || workflowIdempotencyKey(`log:${params.logType}`);
  const cached = await readIdempotent<{ logId: string }>(params.orgId, key);
  if (cached?.logId) return cached;

  const saved = await withOrgClient(params.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, $3, 'success', 200, $4, $5)
       RETURNING id`,
      [params.orgId, params.channelId || 'agent', params.logType, params.logType, JSON.stringify(params.payload)]
    );
    return { logId: res.rows[0].id as string };
  });

  await writeIdempotent(params.orgId, key, saved);
  return saved;
}

export async function upsertWorkItemActivity(params: {
  orgId: string;
  conversationId: string;
  channel: WorkItemChannel;
  type: WorkItemType;
  status: WorkItemStatus;
  assigneeEmployeeId?: string;
  temporalWorkflowId: string;
  inboundEventId?: string;
  businessKey: string;
}): Promise<{ workItemId: string; created: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'upsertWorkItem', params.businessKey);
  const cached = await readIdempotent<{ workItemId: string; created: boolean }>(orgId, key);
  if (cached?.workItemId) return cached;

  const metadata = {
    inboundEventId: params.inboundEventId,
    temporalWorkflowId: params.temporalWorkflowId,
  };

  const saved = await withOrgClient(orgId, async (client) => {
    const existing = await client.query(
      `SELECT id FROM work_items WHERE org_id = $1 AND conversation_id = $2 LIMIT 1`,
      [orgId, params.conversationId]
    );
    if (existing.rows[0]?.id) {
      await client.query(
        `UPDATE work_items
         SET status = $1,
             assignee_employee_id = COALESCE($2::uuid, assignee_employee_id),
             channel = COALESCE($3, channel),
             temporal_workflow_id = $4,
             metadata = metadata || $5::jsonb
         WHERE id = $6 AND org_id = $7`,
        [
          params.status,
          params.assigneeEmployeeId || null,
          params.channel,
          params.temporalWorkflowId,
          JSON.stringify(metadata),
          existing.rows[0].id,
          orgId,
        ]
      );
      return { workItemId: existing.rows[0].id as string, created: false };
    }

    try {
      const inserted = await client.query(
        `INSERT INTO work_items (
           org_id, type, status, assignee_employee_id, conversation_id, channel,
           temporal_workflow_id, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          orgId,
          params.type,
          params.status,
          params.assigneeEmployeeId || null,
          params.conversationId,
          params.channel,
          params.temporalWorkflowId,
          JSON.stringify(metadata),
        ]
      );
      return { workItemId: inserted.rows[0].id as string, created: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      const again = await client.query(
        `SELECT id FROM work_items WHERE org_id = $1 AND conversation_id = $2 LIMIT 1`,
        [orgId, params.conversationId]
      );
      if (!again.rows[0]?.id) throw err;
      return { workItemId: again.rows[0].id as string, created: false };
    }
  });

  await writeIdempotent(orgId, key, saved);
  return saved;
}

export async function updateWorkItemStatusActivity(params: {
  orgId: string;
  workItemId: string;
  status: WorkItemStatus;
  businessKey: string;
  conversationId?: string;
  conversationStatus?: 'needs_attention';
}): Promise<{ workItemId: string; status: WorkItemStatus }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'updateWorkItemStatus', params.businessKey);
  const cached = await readIdempotent<{ workItemId: string; status: WorkItemStatus }>(orgId, key);
  if (cached?.workItemId) return cached;

  switch (params.status) {
    case 'open':
    case 'in_progress':
    case 'waiting_approval':
    case 'needs_attention':
    case 'done':
    case 'cancelled':
      break;
    default: {
      const _exhaustive: never = params.status;
      throw ApplicationFailure.nonRetryable(`Unknown work item status: ${_exhaustive}`, 'InvalidArgumentError');
    }
  }

  const saved = await withOrgClient(orgId, async (client) => {
    await client.query(
      `UPDATE work_items SET status = $1 WHERE id = $2 AND org_id = $3`,
      [params.status, params.workItemId, orgId]
    );
    if (params.conversationId && params.conversationStatus) {
      switch (params.conversationStatus) {
        case 'needs_attention':
          await client.query(
            `UPDATE conversations SET status = 'needs_attention', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
            [params.conversationId, orgId]
          );
          break;
        default: {
          const _exhaustive: never = params.conversationStatus;
          throw ApplicationFailure.nonRetryable(
            `Unknown conversation status: ${_exhaustive}`,
            'InvalidArgumentError'
          );
        }
      }
    }
    return { workItemId: params.workItemId, status: params.status };
  });

  await writeIdempotent(orgId, key, saved);
  return saved;
}

export async function appendWorkEventActivity(params: {
  orgId: string;
  workItemId: string;
  kind: WorkEventKind;
  actor?: string;
  payload?: Record<string, unknown>;
  businessKey: string;
}): Promise<{ eventId: string; duplicate: boolean }> {
  const orgId = requireOrgId(params.orgId);
  switch (params.kind) {
    case 'inbound_received':
    case 'memory_retrieved':
    case 'employee_routed':
    case 'agent_started':
    case 'agent_replied':
    case 'agent_failed':
    case 'needs_attention':
    case 'memory_writeback':
    case 'embed_enqueued':
    case 'confirm_requested':
    case 'confirm_approved':
    case 'confirm_rejected':
    case 'critic_blocked':
      break;
    default: {
      const _exhaustive: never = params.kind;
      throw ApplicationFailure.nonRetryable(`Unknown work event kind: ${_exhaustive}`, 'InvalidArgumentError');
    }
  }
  const key = sideEffectKey(orgId, 'appendWorkEvent', params.businessKey);
  const cached = await readIdempotent<{ eventId: string; duplicate: boolean }>(orgId, key);
  if (cached?.eventId) return { ...cached, duplicate: true };

  const saved = await withOrgClient(orgId, async (client) => {
    try {
      const inserted = await client.query(
        `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          orgId,
          params.workItemId,
          params.kind,
          JSON.stringify(params.payload || {}),
          params.actor || null,
          key,
        ]
      );
      return { eventId: inserted.rows[0].id as string, duplicate: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
      const existing = await client.query(
        `SELECT id FROM work_events WHERE org_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [orgId, key]
      );
      return { eventId: (existing.rows[0]?.id as string) || key, duplicate: true };
    }
  });

  await writeIdempotent(orgId, key, saved);
  return saved;
}

/** M6 parent path: same retrieveMemory as Ask AI / child turn. Never invent facts. */
export async function retrieveMemoryActivity(params: {
  orgId: string;
  workItemId: string;
  conversationId: string;
  businessKey: string;
  query?: string;
  employeeId?: string;
  employeeRole?: string;
}): Promise<RetrieveMemoryActivityResult> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'retrieveMemory', params.businessKey);
  const cached = await readIdempotent<RetrieveMemoryActivityResult>(orgId, key);
  if (cached) return cached;

  const retrieved = await retrieveForEmployee({
    orgId,
    query: params.query || '',
    employeeId: params.employeeId,
    conversationId: params.conversationId,
    workItemId: params.workItemId,
    employeeRole: params.employeeRole,
  });
  const result = toRetrieveActivityResult(retrieved);
  await writeIdempotent(orgId, key, result);
  return result;
}

/** Employee router (E2): loads roster then `route(work_item)`. Never LIMIT 1 for allowlist. */
export async function routeEmployeeActivity(params: {
  orgId: string;
  workItemId: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  userMessage?: string;
  channel?: string;
  businessKey: string;
}): Promise<{
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  passthrough: boolean;
  destination: 'employee' | 'human' | 'dispatch';
  confidence: number;
  reason: string;
  locked: boolean;
}> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'routeEmployee', params.businessKey);
  const cached = await readIdempotent<{
    employeeId?: string;
    employeeName: string;
    employeeRole: string;
    employeePersona: string;
    toolAllowlist: string[];
    passthrough: boolean;
    destination: 'employee' | 'human' | 'dispatch';
    confidence: number;
    reason: string;
    locked: boolean;
  }>(orgId, key);
  if (cached?.employeeName || cached?.destination) return cached;

  const roster = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, name, role, persona, tool_allowlist, status
       FROM ai_employees
       WHERE org_id = $1
       ORDER BY created_at ASC`,
      [orgId]
    );
    const employees: RouteEmployee[] = res.rows.map((row) => {
      const status = row.status === 'paused' ? 'paused' : 'active';
      const tools = Array.isArray(row.tool_allowlist) ? row.tool_allowlist.map(String) : [];
      return {
        id: String(row.id),
        name: String(row.name || ''),
        role: String(row.role || ''),
        persona: personaText(row.persona),
        toolAllowlist: tools,
        status,
      };
    });
    return employees;
  });

  const routed = route({
    orgId,
    userMessage: params.userMessage || '',
    channel: params.channel,
    preferredEmployeeId: params.employeeId,
    employees: roster,
  });

  const merged = mergeRoutedForCaller(routed, {
    toolAllowlist: params.toolAllowlist,
    employeeName: params.employeeName,
    employeeRole: params.employeeRole,
    employeePersona: params.employeePersona,
  });
  const result = {
    employeeId: merged.employeeId,
    employeeName: merged.employeeName,
    employeeRole: merged.employeeRole,
    employeePersona: merged.employeePersona,
    toolAllowlist: merged.toolAllowlist,
    passthrough: false,
    destination: merged.destination,
    confidence: merged.confidence,
    reason: merged.reason,
    locked: merged.locked,
  };

  await writeIdempotent(orgId, key, result);
  return result;
}

/**
 * Enqueue EmbedWorkflow off the inbound HTTP thread. Does not await embed.
 *
 * Gated by writeback-policy like every other memory write: a raw inbound
 * customer message is not a durable fact, and embedding it made it
 * retrievable org-wide (another customer's persona could cite it). The
 * inbound WorkItem path passes no event, so it records a policy no-op;
 * durable facts land through MemoryWriteBackWorkflow instead.
 */
export async function enqueueEmbedActivity(params: {
  orgId: string;
  workItemId: string;
  conversationId: string;
  businessKey: string;
  event?: WriteBackEvent | null;
}): Promise<{ enqueued: boolean; noOp: boolean; policyBlocked?: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'enqueueEmbed', params.businessKey);
  const cached = await readIdempotent<{ enqueued: boolean; noOp: boolean; policyBlocked?: boolean }>(orgId, key);
  if (cached) return cached;

  if (!isAllowedWriteBack(params.event ?? null)) {
    const blocked = { enqueued: false, noOp: true, policyBlocked: true };
    await writeIdempotent(orgId, key, blocked);
    return blocked;
  }

  const text = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT content FROM messages
        WHERE org_id = $1 AND conversation_id = $2 AND role = 'user'
        ORDER BY created_at DESC
        LIMIT 1`,
      [orgId, params.conversationId]
    );
    return (res.rows[0]?.content as string | undefined) || '';
  });

  if (!text.trim()) {
    const result = { enqueued: false, noOp: true };
    await writeIdempotent(orgId, key, result);
    return result;
  }

  const queued = await enqueueEmbedJobFromWorker({
    orgId,
    source: 'conversation',
    sourceRef: params.conversationId,
    text,
  });
  const result = { enqueued: queued.enqueued, noOp: false };
  await writeIdempotent(orgId, key, result);
  return result;
}

/** M4: hash-idempotent write-back. Prefer MemoryWriteBackWorkflow child. */
export async function writeBackMemoryActivity(params: {
  orgId: string;
  workItemId: string;
  conversationId: string;
  businessKey: string;
  transcriptExcerpt?: string;
  toolResults?: unknown;
  closed?: boolean;
}): Promise<{
  written: boolean;
  factCount: number;
  skippedDuplicates: number;
  fieldUpdatesApplied: number;
  needsAttention: boolean;
  openQuestionCount: number;
  noOp?: boolean;
}> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'writeBackMemory', params.businessKey);
  const cached = await readIdempotent<{
    written: boolean;
    factCount: number;
    skippedDuplicates: number;
    fieldUpdatesApplied: number;
    needsAttention: boolean;
    openQuestionCount: number;
    noOp?: boolean;
  }>(orgId, key);
  if (cached) return cached;

  const result = await runMemoryWriteBack({
    orgId,
    workItemId: params.workItemId,
    conversationId: params.conversationId,
    transcriptExcerpt: params.transcriptExcerpt,
    toolResults: params.toolResults,
    closed: params.closed,
    businessKey: params.businessKey,
  });
  await writeIdempotent(orgId, key, result);
  return result;
}

export async function markNeedsAttentionActivity(params: {
  orgId: string;
  workItemId: string;
  conversationId: string;
  reason: string;
  businessKey: string;
}): Promise<{ workItemId: string; status: 'needs_attention' }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'markNeedsAttention', params.businessKey);
  const cached = await readIdempotent<{ workItemId: string; status: 'needs_attention' }>(orgId, key);
  if (cached?.workItemId) return cached;

  const saved = await withOrgClient(orgId, async (client) => {
    await client.query(
      `UPDATE work_items SET status = 'needs_attention' WHERE id = $1 AND org_id = $2`,
      [params.workItemId, orgId]
    );
    await client.query(
      `UPDATE conversations SET status = 'needs_attention', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      [params.conversationId, orgId]
    );
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'agent', 'WORK_ITEM_NEEDS_ATTENTION', 'error', 500, $2, $3)`,
      [
        orgId,
        `work_item ${params.workItemId} needs_attention`,
        JSON.stringify({ workItemId: params.workItemId, reason: params.reason.slice(0, 500) }),
      ]
    );
    return { workItemId: params.workItemId, status: 'needs_attention' as const };
  });

  await writeIdempotent(orgId, key, saved);
  return saved;
}

export async function criticCheck(params: {
  orgId: string;
  workItemId: string;
  draft: string;
  intent: 'send' | 'publish' | 'sign';
  businessKey: string;
}): Promise<{
  allow: boolean;
  policy: string;
  reason: string;
  violations: string[];
  source: string;
}> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'criticCheck', params.businessKey);
  const cached = await readIdempotent<{
    allow: boolean;
    policy: string;
    reason: string;
    violations: string[];
    source: string;
  }>(orgId, key);
  if (cached && typeof cached.allow === 'boolean') return cached;

  const result = await runCriticCheck({
    orgId,
    draft: params.draft,
    intent: params.intent,
    businessKey: params.businessKey,
  });
  await writeIdempotent(orgId, key, result);
  return result;
}
export { refreshAllOrgMetersActivity } from './billing-sweep.js';
export { purgeFailedWebhooksActivity } from './dlq-retention.js';
export { reapStaleDsrActivity } from './dsr-reaper.js';
