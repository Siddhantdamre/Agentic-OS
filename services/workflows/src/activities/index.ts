import { llmChat, countLlmCalls } from '../llm/gateway.js';
import { reviseUntilAllowed, reviseDraftWithLiteLLM } from './critic-revise.js';
import { buildReplyCritique, buildReplyReviser } from '../reply-gate.js';
import { buildCrewPlanPrompt, extractPlanJson, validateCrewPlan, type CrewCandidate, type CrewPlan } from '../crew-planner.js';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { claimIdempotent, readIdempotent, sideEffectKey, withOrgClient, writeIdempotent } from '../db.js';
import { runAutonomousAgentDirect } from '../agent-client.js';
import { logWorkerTurnTrace } from '../langfuse-trace.js';
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
    const result = await runAutonomousAgentDirect(input, { priorMessages, retrievedMemory });
    // OPS-B03: worker turns (inbound channels, crews) were never traced.
    void logWorkerTurnTrace({
      name: 'AgentTurn-Worker',
      orgId: input.orgId,
      input: input.userMessage,
      output: result.replyMessage,
      usage: result.usage,
      level: result.success ? 'DEFAULT' : 'ERROR',
      metadata: {
        employeeId: input.employeeId ?? null,
        employeeRole: input.employeeRole ?? null,
        conversationId: input.conversationId ?? null,
        usedTools: result.usedTools,
        steps: result.executedSteps.length,
        error: result.error ?? null,
      },
    });
    return result;
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
    employeeId: params.employeeId,
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
/**
 * Choose which employees work on a request, from the org's real roster.
 *
 * Runs as an activity (not in the workflow) for two reasons: it reads the DB
 * and calls a model, and its output is non-deterministic — both forbidden in
 * Temporal workflow code, which must replay identically from history.
 *
 * FAILS SOFT BY DESIGN. Any problem — no roster, model unreachable, unparseable
 * or hallucinated plan — returns `mode: 'solo'`, i.e. the behaviour before this
 * existed. A planning failure must never turn into a failed customer request.
 *
 * The security boundary lives in `validateCrewPlan`: assignments may only name
 * employees on this org's roster, and tool allowlists are taken from the DB
 * record, never from the model. See crew-planner.ts.
 */
export async function planCrewActivity(params: {
  orgId: string;
  userMessage: string;
  /** Cap the roster considered. Keeps the prompt bounded on large orgs. */
  maxCandidates?: number;
}): Promise<CrewPlan> {
  const orgId = requireOrgId(params.orgId);
  const solo = (reason: string): CrewPlan => ({ mode: 'solo', assignments: [], reason, rejected: [] });

  const candidates = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, name, role, persona, tool_allowlist
         FROM ai_employees
        WHERE org_id = $1 AND status = 'active'
        ORDER BY created_at ASC
        LIMIT $2`,
      [orgId, Math.max(1, Math.min(20, params.maxCandidates ?? 10))]
    );
    return res.rows.map<CrewCandidate>((r) => ({
      employeeId: String(r.id),
      name: String(r.name ?? ''),
      role: String(r.role ?? ''),
      persona: personaText(r.persona),
      // tool_allowlist is TEXT[] in migration 001 but has been written as a JSON
      // string by some call sites; accept both rather than silently yielding an
      // empty allowlist, which would strip a specialist of every tool.
      toolAllowlist: Array.isArray(r.tool_allowlist)
        ? r.tool_allowlist.map(String)
        : (() => {
            try {
              const parsed = JSON.parse(String(r.tool_allowlist ?? '[]'));
              return Array.isArray(parsed) ? parsed.map(String) : [];
            } catch {
              return [];
            }
          })(),
    }));
  });

  // A crew needs at least two employees to exist at all.
  if (candidates.length < 2) return solo(`roster has ${candidates.length} active employee(s)`);

  // Through the gateway: the model comes from the workspace's budget, not from
  // LITELLM_MODEL. Crew planning is a paid call like any other and had never
  // consulted the budget. See llm/gateway.ts.
  const planned = await llmChat({
    orgId,
    purpose: 'crew-plan',
    maxTokens: 600,
    temperature: 0,
    timeoutMs: 15_000,
    messages: [
      {
        role: 'system',
        content:
          'You allocate work to AI employees. Reply with ONLY the JSON object described. Never invent an employee id.',
      },
      { role: 'user', content: buildCrewPlanPrompt(params.userMessage, candidates) },
    ],
  });
  if (planned.error || !planned.content) {
    return solo(`planner unavailable (${planned.error || 'empty response'})`);
  }
  return validateCrewPlan(extractPlanJson(planned.content), candidates);
}

/**
 * Critic gate WITH bounded self-revision.
 *
 * Drop-in replacement for `criticCheck` on paths that draft customer-facing
 * text. When the critic blocks something mechanically fixable (an overclaim to
 * remove, a disclosure to add) the agent gets up to `maxRevisions` attempts to
 * correct it — each re-judged from scratch by the same unmodified critic.
 *
 * It can only ever REDUCE escalations: `fair_housing` blocks never revise,
 * anything unresolved still escalates, and an LLM outage falls straight back to
 * today's behaviour. See critic-revise.ts for the full safety model.
 *
 * The loop lives in this activity rather than the workflow because it performs
 * I/O — Temporal workflow code must stay deterministic and replayable.
 */
export async function criticCheckWithRevision(params: {
  orgId: string;
  workItemId: string;
  draft: string;
  intent: 'send' | 'publish' | 'sign';
  businessKey: string;
  maxRevisions?: number;
  /**
   * Everything the agent retrieved this turn (tool outputs). When supplied, the
   * draft must additionally be GROUNDED: every figure, date and reference it
   * states has to appear in this evidence. Omit to run compliance checks only.
   *
   * Deliberately opt-in per call site: a path that legitimately replies without
   * retrieving anything (a plain acknowledgement) would otherwise have every
   * number it mentions treated as unsupported.
   */
  evidence?: string;
  /**
   * Dates the PLATFORM supplied to the agent this turn — today, next Saturday
   * and so on. Kept OUT of `evidence` on purpose: folding them in let a date
   * block license an unrelated figure. On 23 August the block reads
   * "Saturday, 30 August", and those digits grounded an invented "30% off".
   * Consulted only for `date` claims; money and percentages never see it.
   */
  dateContext?: string;
}): Promise<{
  allow: boolean;
  finalDraft: string;
  policy: string;
  reason: string;
  violations: string[];
  revisionsUsed: number;
  stopReason: string;
  escalationReason?: string;
  attempts: Array<{ attempt: number; allowed: boolean; policy: string; violations: string[] }>;
  /** A paid call was dispatched to judge or rewrite this reply. A COST signal. */
  usedModel: boolean;
  /** How many. Distinguishes one critic call from a three-revision loop. */
  modelCalls: number;
}> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'criticCheckWithRevision', params.businessKey);
  const cached = await readIdempotent<any>(orgId, key);
  if (cached && typeof cached.allow === 'boolean') return cached;

  // Compliance always runs. Grounding is layered on when the caller supplies
  // evidence — composed into ONE critique so a rewrite fixing compliance cannot
  // introduce an invented figure (and vice versa), and so the single revision
  // loop's cap, no-progress guard and escalate-only rules govern both.
  // `undefined` and `''` mean opposite things and MUST NOT be conflated:
  //   undefined -> caller opts out of grounding (compliance only)
  //   ''        -> the agent retrieved NOTHING, so no figure is defensible
  // Using a falsy test here (`!params.evidence`) made the second case skip
  // grounding entirely — i.e. the most dangerous input got the least checking.
  // Caught by the live smoke test; unit tests missed it because they call
  // buildReplyCritique directly with an explicit flag.
  const skipGrounding = params.evidence === undefined;
  const gateOptions = {
    evidence: params.evidence ?? '',
    skipGrounding,
    grounding: { dateContext: params.dateContext ?? '' },
  };
  const baseDeps = {
    critique: (draft: string, intent: 'send' | 'publish' | 'sign') =>
      runCriticCheck({ orgId, draft, intent, businessKey: params.businessKey }),
    // Bound to this org so the revision's tokens land on the right tenant's
    // budget, same as the critic call above it.
    revise: (draft: string, verdict: Parameters<typeof reviseDraftWithLiteLLM>[1], promptOverride?: string) =>
      reviseDraftWithLiteLLM(draft, verdict, promptOverride, orgId),
  };

  // Counted at the gateway, which the lint guarantees is the only way to reach
  // the proxy — so this sees the critic call, every revision call, and any
  // paid call added inside this loop later, with no flag threaded through the
  // critique/revision composition. See countLlmCalls in llm/gateway.ts.
  const { result: outcome, dispatched } = await countLlmCalls(() => reviseUntilAllowed(
    params.draft,
    params.intent,
    {
      critique: buildReplyCritique(baseDeps, gateOptions),
      revise: buildReplyReviser(baseDeps, gateOptions),
    },
    { maxRevisions: params.maxRevisions }
  ));

  const last = outcome.attempts[outcome.attempts.length - 1];
  const result = {
    allow: outcome.allowed,
    finalDraft: outcome.finalDraft,
    policy: last?.policy ?? 'ok',
    reason: last?.reason ?? '',
    violations: last?.violations ?? [],
    revisionsUsed: outcome.revisionsUsed,
    stopReason: outcome.stopReason,
    escalationReason: outcome.escalationReason,
    // Whether judging this reply cost anything. Stored in the idempotency
    // record with everything else, so a Temporal replay reports what the
    // ORIGINAL run spent rather than zero — the replay itself dispatches
    // nothing, and reporting that would make spend vanish on every retry.
    usedModel: dispatched > 0,
    modelCalls: dispatched,
    // Verdict history only: drafts can be long and the text already lives on
    // the message/work-item record. What audit needs is the chain of rulings.
    attempts: outcome.attempts.map((a) => ({
      attempt: a.attempt,
      allowed: a.allowed,
      policy: a.policy,
      violations: a.violations,
    })),
  };

  await writeIdempotent(orgId, key, result);
  return result;
}

/**
 * Record a question the agent could not answer.
 *
 * The point of an AI employee is that it gets better at THIS business. It only
 * can if every miss is written down: the operator answers the question once in
 * the dashboard, `resolve_knowledge_gap` turns that answer into an org_memory
 * fact, and retrieval finds it forever after. One correction, permanent
 * capability.
 *
 * Deliberately non-fatal. A failure to record a gap must never fail a reply
 * that was otherwise fine — the customer already has their answer, and losing
 * one row of learning telemetry is not worth an escalation.
 */
export async function recordKnowledgeGapActivity(params: {
  orgId: string;
  question: string;
  agentReply: string;
  detectedVia: 'denied' | 'corrected' | 'no_reply';
  conversationId?: string;
  workItemId?: string;
}): Promise<{ gapId: string | null }> {
  const orgId = requireOrgId(params.orgId);
  const question = (params.question || '').trim();
  if (!question) return { gapId: null };

  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT record_knowledge_gap($1::uuid, $2::text, $3::text, $4::text,
                                     $5::uuid, $6::uuid, $7::text) AS id`,
        [
          orgId,
          question.slice(0, 2000),
          (params.agentReply || '').slice(0, 4000),
          params.detectedVia,
          params.conversationId || null,
          params.workItemId || null,
          // The work item id doubles as the dedupe key: a Temporal retry of the
          // same work item must bump `times_asked` zero times, or the operator's
          // "asked 40 times" priority signal becomes "retried 40 times".
          params.workItemId || null,
        ]
      );
      return { gapId: (res.rows[0]?.id as string) || null };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Context.current().log.warn('knowledge gap not recorded', { message });
    return { gapId: null };
  }
}

/**
 * Put an approval request somewhere a human can actually find it.
 *
 * WorkItemWorkflow already emitted a `confirm_requested` work event and set
 * the item to waiting_approval. Neither is answerable: the event log is
 * append-only and nothing rendered it. Measured before this shipped, 24
 * requests were waiting and 0 had ever been answered, the oldest for thirteen
 * days.
 *
 * This writes the row /api/approvals reads, carrying the workflow id so a
 * decision can be signalled back — best effort, because the workflow only
 * waits two minutes and a human answering in ten is still answering.
 *
 * Never throws: failing the turn because the bookkeeping about the turn failed
 * would turn a pause into an outage.
 */
export async function recordApprovalRequestActivity(params: {
  orgId: string;
  workItemId: string;
  conversationId?: string;
  actionClass: string;
  summary: string;
  draft?: string;
  workflowId?: string;
}): Promise<{ requestId: string | null }> {
  const orgId = requireOrgId(params.orgId);
  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT record_approval_request($1::uuid, $2::uuid, $3::uuid, $4::text,
                                         $5::text, $6::text, $7::text) AS id`,
        [
          orgId,
          params.workItemId || null,
          params.conversationId || null,
          params.actionClass,
          (params.summary || '').slice(0, 500),
          (params.draft || '').slice(0, 4000),
          params.workflowId || null,
        ]
      );
      return { requestId: (res.rows[0]?.id as string) || null };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Context.current().log.warn('approval request not recorded', { message });
    return { requestId: null };
  }
}

/**
 * Record a promise the agent just made.
 *
 * "I'll check and get back to you" used to evaporate the moment the turn
 * ended: nothing tracked a follow-up, a deadline or an owner. That is the
 * single biggest reason an assistant feels unreliable — an unkept promise
 * costs more trust than several wrong answers, and it was invisible in every
 * metric here, because the conversation looked resolved and the customer was
 * simply gone.
 *
 * `dueInMinutes` is RELATIVE and the database owns the clock. The caller is a
 * Temporal workflow, where `new Date()` differs across replay, so a due date
 * computed inline would fail the determinism check.
 *
 * Never throws. A promise that fails to record is a lost obligation, which is
 * bad — but failing the reply a customer is waiting on, to protect the
 * bookkeeping about that reply, is worse.
 */
export async function recordCommitmentActivity(params: {
  orgId: string;
  promise: string;
  question: string;
  dueInMinutes: number;
  conversationId?: string;
  workItemId?: string;
  /** Idempotency: a replayed turn must not open a second obligation. */
  sourceMessageId: string;
}): Promise<{ commitmentId: string | null }> {
  const orgId = requireOrgId(params.orgId);
  const promise = (params.promise || '').trim();
  if (!promise) return { commitmentId: null };

  try {
    return await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT record_commitment($1::uuid, $2::uuid, $3::uuid, $4::text,
                                  $5::text, $6::int, $7::text) AS id`,
        [
          orgId,
          params.conversationId || null,
          params.workItemId || null,
          promise.slice(0, 2000),
          (params.question || '').slice(0, 2000),
          params.dueInMinutes,
          params.sourceMessageId,
        ]
      );
      return { commitmentId: (res.rows[0]?.id as string) || null };
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Context.current().log.warn('commitment not recorded', { message });
    return { commitmentId: null };
  }
}

export { checkLlmBudgetActivity } from './llm-budget.js';
export { recordTaskSupervisionActivity } from './task-supervision.js';
export { researchTopicActivity } from './market-research.js';
