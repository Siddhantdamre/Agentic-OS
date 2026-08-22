import {
  proxyActivities,
  executeChild,
  startChild,
  ParentClosePolicy,
  defineSignal,
  setHandler,
  workflowInfo,
  condition,
  sleep,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { AutonomousAgentWorkflow } from './AutonomousAgentWorkflow.js';
import {
  buildEvidence,
  detectThirdPartyPiiRequest,
  formatForChannel,
  isKnowledgeGap,
  stripMechanismTalk,
  stripPreamble,
  stripPlaceholders,
  INTERIM_ACK_REPLY,
  HUMAN_REVIEW_REPLY,
  SERVICE_FALLBACK_REPLY,
  PRIVACY_REFUSAL,
  sanitiseCustomerReply,
} from '../reply-gate.js';
import { MemoryWriteBackWorkflow } from './MemoryWriteBackWorkflow.js';
import { isHumanDestination } from '../route-employee.js';
import { resolveInboundHitlGate } from '../inbound-hitl.js';

// Local types (WS-10 owns packages/shared-types — do not add work-item types there).
export type WorkItemChannel = 'whatsapp' | 'chatwoot' | 'inbox' | 'ask_ai' | 'unknown';
export type WorkItemStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_approval'
  | 'needs_attention'
  | 'done'
  | 'cancelled';
export type WorkItemType = 'conversation';

export type WorkEventKind =
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
  | 'critic_blocked'
  // Emitted whenever self-revision ran, successful or not — measuring how often
  // it rescues a reply (vs. just adding latency) is the point.
  | 'critic_revised';

export interface WorkItemWorkflowInput {
  orgId: string;
  channel: WorkItemChannel;
  conversationId: string;
  status?: WorkItemStatus;
  inboundEventId?: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  connectedChannels?: string[];
  userMessage: string;
  idempotencyKey?: string;
}

export interface WorkItemWorkflowResult {
  workItemId: string;
  status: WorkItemStatus;
  replyMessage?: string;
  executedSteps?: unknown[];
  savedByWorkflow: boolean;
  success: boolean;
  error?: string;
  hitlDecision?: WorkItemConfirmDecision;
}

export type WorkItemConfirmDecision = 'approved' | 'rejected';

/** O7: PlanCard / owner-WhatsApp approve/reject signals this; inbound send/pay/sign waits before tools. */
export const approveWorkItemSignal = defineSignal<[WorkItemConfirmDecision?]>('approveWorkItem');
export const rejectWorkItemSignal = defineSignal('rejectWorkItem');

const {
  upsertWorkItemActivity,
  updateWorkItemStatusActivity,
  appendWorkEventActivity,
  retrieveMemoryActivity,
  routeEmployeeActivity,
  criticCheck,
  criticCheckWithRevision,
  recordKnowledgeGapActivity,
  enqueueEmbedActivity,
  markNeedsAttentionActivity,
  saveMessageActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

/**
 * How long a reply waits for human approval before the customer is
 * acknowledged instead.
 *
 * Two minutes, and short on purpose: a customer on WhatsApp must never wait on
 * an operator's response time. The operator keeps the item in needs_attention
 * and follows up properly; the customer just stops being ignored. A workflow
 * constant, never process.env — reading env inside a workflow is
 * non-deterministic across replay.
 */
const HITL_WAIT_TIMEOUT = '2 minutes';

/**
 * How long a customer waits in silence before the agent says it is working.
 *
 * 30s, from measurement: p50 for a good reply is ~21s, so most answers arrive
 * before this fires and the interim message stays rare. It only appears on the
 * genuinely slow turns — which are exactly the ones where silence reads as
 * being ignored. A workflow constant, never process.env: reading env inside a
 * workflow is non-deterministic across replay.
 */
const INTERIM_ACK_DELAY = '30 seconds';

function sessionKeyForWorkItem(workItemId: string): string {
  return workItemId;
}

function nextStatus(event: 'start' | 'done' | 'fail' | 'await_confirm' | 'cancel'): WorkItemStatus {
  switch (event) {
    case 'start':
      return 'in_progress';
    case 'done':
      return 'done';
    case 'fail':
      return 'needs_attention';
    case 'await_confirm':
      return 'waiting_approval';
    case 'cancel':
      return 'cancelled';
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function eventKindForConfirm(decision: WorkItemConfirmDecision): WorkEventKind {
  switch (decision) {
    case 'approved':
      return 'confirm_approved';
    case 'rejected':
      return 'confirm_rejected';
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * Q1 wrap: inbound WorkItemWorkflow around AutonomousAgentWorkflow.
 * Does not replace the child. Does not auto-spawn CrewWorkflow.
 * Session for the child turn: darex:{orgId}:{workItemId} via sessionKey=workItemId.
 */
export async function WorkItemWorkflow(input: WorkItemWorkflowInput): Promise<WorkItemWorkflowResult> {
  const parentId = workflowInfo().workflowId;
  const businessKey = input.idempotencyKey || input.inboundEventId || parentId;
  let lastConfirm: WorkItemConfirmDecision | undefined;

  setHandler(approveWorkItemSignal, (decision) => {
    lastConfirm = decision === 'rejected' ? 'rejected' : 'approved';
  });
  setHandler(rejectWorkItemSignal, () => {
    lastConfirm = 'rejected';
  });

  const upserted = await upsertWorkItemActivity({
    orgId: input.orgId,
    conversationId: input.conversationId,
    channel: input.channel,
    type: 'conversation',
    status: nextStatus('start'),
    assigneeEmployeeId: input.employeeId,
    temporalWorkflowId: parentId,
    inboundEventId: input.inboundEventId,
    businessKey,
  });

  const workItemId = upserted.workItemId;

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'inbound_received',
    actor: 'webhook',
    payload: {
      conversationId: input.conversationId,
      channel: input.channel,
      inboundEventId: input.inboundEventId,
    },
    businessKey: `${businessKey}:inbound_received`,
  });

  const memory = await retrieveMemoryActivity({
    orgId: input.orgId,
    workItemId,
    conversationId: input.conversationId,
    query: input.userMessage,
    employeeId: input.employeeId,
    businessKey: `${businessKey}:retrieveMemory`,
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'memory_retrieved',
    actor: 'system',
    payload: { factCount: memory.facts.length, noOp: memory.noOp },
    businessKey: `${businessKey}:memory_retrieved`,
  });

  // E2: route(work_item). Emergency → human/dispatch, not ISA. Name lock from "Ask Marcus to".
  const routed = await routeEmployeeActivity({
    orgId: input.orgId,
    workItemId,
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    employeeRole: input.employeeRole,
    employeePersona: input.employeePersona,
    toolAllowlist: input.toolAllowlist,
    userMessage: input.userMessage,
    channel: input.channel,
    businessKey: `${businessKey}:routeEmployee`,
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'employee_routed',
    actor: 'system',
    payload: {
      employeeId: routed.employeeId,
      employeeName: routed.employeeName,
      passthrough: routed.passthrough,
      destination: routed.destination,
      confidence: routed.confidence,
      reason: routed.reason,
      locked: routed.locked,
    },
    businessKey: `${businessKey}:employee_routed`,
  });

  if (isHumanDestination(routed.destination || 'employee')) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: routed.reason || 'human_dispatch',
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: routed.reason, destination: routed.destination },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      savedByWorkflow: true,
      success: false,
      error: routed.reason || 'human_dispatch',
    };
  }

  // HOOK(later-ws): embed enqueue — no-op until EmbedWorkflow is registered additively.
  //
  // NON-FATAL BY CONTRACT. Memory/RAG is optional enrichment; the reply is the
  // product. A misconfigured embeddings provider previously threw here, and
  // Temporal's retries (5 x 120s) exhausted the worker's activity slots so
  // agent turns were never scheduled — replies stopped entirely. Swallowing
  // the error keeps the turn running with no memory, and the event records
  // exactly why so a silent degradation is still visible.
  let embed: { enqueued?: boolean; noOp?: boolean } = {};
  let embedSkipReason: string | null = null;
  try {
    embed = await enqueueEmbedActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      businessKey: `${businessKey}:enqueueEmbed`,
    });
  } catch (err: any) {
    embedSkipReason = String(err?.cause?.message || err?.message || 'embed_failed').slice(0, 200);
  }
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'embed_enqueued',
    actor: 'system',
    payload: embedSkipReason
      ? { enqueued: false, noOp: true, skipped: true, reason: embedSkipReason }
      : { enqueued: embed.enqueued, noOp: embed.noOp },
    businessKey: `${businessKey}:embed_enqueued`,
  });

  // O7: PlanExecute pattern — wait BEFORE executeChild so send/pay/sign
  // tools cannot run until approveWorkItem. Greetings / read-only skip.
  const preHitl = resolveInboundHitlGate({ userMessage: input.userMessage });
  if (preHitl.wait) {
    await updateWorkItemStatusActivity({
      orgId: input.orgId,
      workItemId,
      status: nextStatus('await_confirm'),
      conversationId: input.conversationId,
      conversationStatus: 'needs_attention',
      businessKey: `${businessKey}:status_waiting_approval`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'confirm_requested',
      actor: 'system',
      payload: { classes: preHitl.classes, phase: 'before_tools' },
      businessKey: `${businessKey}:confirm_requested`,
    });

    // Bounded, and strictly fail-CLOSED. Side-effecting send/pay/sign tools have
    // not run yet, so a timeout must never be read as approval — an unanswered
    // prompt is not consent, and money moving because nobody replied is the one
    // outcome this gate exists to prevent. The agent turn simply does not run.
    // The customer still gets an acknowledgement so they are not left in
    // silence, and the operator still has the item.
    const approved = await condition(() => lastConfirm !== undefined, HITL_WAIT_TIMEOUT);
    if (!approved) {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: 'needs_attention',
        actor: 'system',
        payload: { reason: 'hitl_timeout', phase: 'before_tools', classes: preHitl.classes },
        businessKey: `${businessKey}:hitl_timeout_before_tools`,
      });
      const ackReply = formatForChannel(HUMAN_REVIEW_REPLY, input.channel);
      if (input.conversationId) {
        await saveMessageActivity({
          orgId: input.orgId,
          conversationId: input.conversationId,
          role: 'assistant',
          content: ackReply,
          idempotencyKey: `${businessKey}:save-hitl-timeout-ack-pre`,
        });
      }
      return {
        workItemId,
        status: nextStatus('fail'),
        replyMessage: ackReply,
        savedByWorkflow: true,
        success: false,
        error: 'hitl_timeout',
      };
    }
    if (lastConfirm === 'rejected') {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: eventKindForConfirm('rejected'),
        actor: 'owner',
        payload: { decision: 'rejected', classes: preHitl.classes },
        businessKey: `${businessKey}:confirm_rejected`,
      });
      await markNeedsAttentionActivity({
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        reason: 'hitl_rejected',
        businessKey: `${businessKey}:needs_attention`,
      });
      await updateWorkItemStatusActivity({
        orgId: input.orgId,
        workItemId,
        status: nextStatus('cancel'),
        businessKey: `${businessKey}:status_cancelled`,
      });
      return {
        workItemId,
        status: nextStatus('cancel'),
        savedByWorkflow: true,
        success: false,
        hitlDecision: 'rejected',
        error: 'hitl_rejected',
      };
    }
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: eventKindForConfirm('approved'),
      actor: 'owner',
      payload: { decision: 'approved', classes: preHitl.classes },
      businessKey: `${businessKey}:confirm_approved`,
    });
  }

  // Third-party PII: refuse deterministically, BEFORE the agent turn.
  //
  // Placed here rather than after the reply for two reasons. First, no tool is
  // consulted at all, so the refusal cannot depend on whether a connector
  // happens to be enabled — the previous behaviour declined only because
  // WhatsApp could not read history, which would have reversed the moment
  // history-reading was switched on. Second, there is no model call for an
  // injection to argue with. It also removes a full agent turn of latency.
  if (detectThirdPartyPiiRequest(input.userMessage)) {
    const refusal = formatForChannel(PRIVACY_REFUSAL, input.channel);
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'reply_sanitised',
      actor: 'system',
      payload: { violations: ['third_party_pii_request'], disclosedInternals: false },
      businessKey: `${businessKey}:third_party_pii`,
    });
    if (input.conversationId) {
      await saveMessageActivity({
        orgId: input.orgId,
        conversationId: input.conversationId,
        role: 'assistant',
        content: refusal,
        idempotencyKey: `${businessKey}:save-privacy-refusal`,
      });
    }
    await updateWorkItemStatusActivity({
      orgId: input.orgId,
      workItemId,
      status: nextStatus('done'),
      conversationId: input.conversationId,
      businessKey: `${businessKey}:status_privacy_refusal`,
    });
    return {
      workItemId,
      status: nextStatus('done'),
      replyMessage: refusal,
      executedSteps: [],
      savedByWorkflow: true,
      success: true,
    };
  }

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'agent_started',
    actor: routed.employeeId || 'employee',
    payload: { sessionKey: sessionKeyForWorkItem(workItemId) },
    businessKey: `${businessKey}:agent_started`,
  });

  const childInput: AgentTaskInput = {
    orgId: input.orgId,
    conversationId: input.conversationId,
    channelId: input.channelId,
    employeeId: routed.employeeId,
    employeeName: routed.employeeName,
    employeeRole: routed.employeeRole,
    employeePersona: routed.employeePersona,
    toolAllowlist: routed.toolAllowlist,
    connectedChannels: input.connectedChannels,
    userMessage: input.userMessage,
    sessionKey: sessionKeyForWorkItem(workItemId),
    idempotencyKey: `${businessKey}:agent-turn`,
    // The child must NOT write the assistant message. It persists the raw draft
    // the moment the agent produces it, which is before the critic, the
    // grounding check, the disclosure sanitiser and the HITL gate have run — so
    // every one of those gates was operating on a copy while the ungated text
    // was already in `messages` and on the customer's screen.
    //
    // Found when a correctly-sanitised reply still showed the pre-sanitiser
    // text in the quality run. The parent now persists, once, after the reply
    // is actually cleared to send.
    skipPersist: true,
  };

  let childResult: AgentTaskResult;
  try {
    const childRun = executeChild(AutonomousAgentWorkflow, {
      workflowId: `${parentId}-turn`,
      args: [childInput],
      workflowExecutionTimeout: '20 minutes',
    });

    // Say something before the customer starts wondering.
    //
    // Bounding the retry budget capped the WORST case at ~2 minutes, but it
    // cannot make a slow answer fast: the slowest CORRECT reply measured was
    // 93.1s, so tightening timeouts further would cut off work that was going
    // to succeed. Silence is the thing that makes a customer feel ignored, not
    // slowness — so the agent keeps working and simply says so.
    //
    // A durable Temporal timer, raced against the child. Deterministic across
    // replay, and the child is never cancelled: the real answer still follows.
    const stillWorking = Symbol('still-working');
    const raced = await Promise.race([
      childRun,
      sleep(INTERIM_ACK_DELAY).then(() => stillWorking),
    ]);

    if (raced === stillWorking) {
      // Interim only, never a substitute for the answer. It asserts nothing,
      // because at this point nothing has been checked.
      if (input.conversationId) {
        await saveMessageActivity({
          orgId: input.orgId,
          conversationId: input.conversationId,
          role: 'assistant',
          content: formatForChannel(INTERIM_ACK_REPLY, input.channel),
          idempotencyKey: `${businessKey}:save-interim-ack`,
        });
      }
      childResult = await childRun;
    } else {
      childResult = raced as AgentTaskResult;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Compensation: log + needs_attention. Never silent-resend the channel reply.
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: message,
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'agent_failed',
      actor: 'system',
      payload: { error: message.slice(0, 500) },
      businessKey: `${businessKey}:agent_failed`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: message.slice(0, 500) },
      businessKey: `${businessKey}:needs_attention_event`,
    });

    // NEVER go silent.
    //
    // This path used to return with no message saved at all. When the upstream
    // model returned 502, the customer got nothing — 5 of 12 questions in the
    // completion run ended in total silence. Silence is the worst outcome
    // available: the customer assumes they were ignored, and unlike a wrong
    // answer nobody can even see that it happened.
    //
    // The original comment here said "never silent-resend the channel reply",
    // and that still holds — this is not a resend of a business answer. It is a
    // bare acknowledgement that asserts no fact, so it cannot be wrong, needs
    // no grounding, and is safe to send without knowing what was asked. It
    // always accompanies the needs_attention above, so a human follows up.
    const fallbackReply = formatForChannel(SERVICE_FALLBACK_REPLY, input.channel);
    if (input.conversationId) {
      await saveMessageActivity({
        orgId: input.orgId,
        conversationId: input.conversationId,
        role: 'assistant',
        content: fallbackReply,
        idempotencyKey: `${businessKey}:save-service-fallback`,
      });
    }
    // The question still deserves an answer, so it goes on the gap list as
    // `no_reply`. Without this a provider outage silently erases the questions
    // it swallowed, and nobody ever learns what customers were asking.
    await recordKnowledgeGapActivity({
      orgId: input.orgId,
      question: input.userMessage,
      agentReply: fallbackReply,
      detectedVia: 'no_reply',
      conversationId: input.conversationId,
      workItemId,
    });

    return {
      workItemId,
      status: nextStatus('fail'),
      replyMessage: fallbackReply,
      savedByWorkflow: true,
      success: false,
      error: message,
    };
  }

  const reply = (childResult.replyMessage || '').trim();
  if (!childResult.success || !reply) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: childResult.error || 'empty_reply',
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: childResult.error || 'empty_reply' },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      replyMessage: reply || undefined,
      executedSteps: childResult.executedSteps,
      savedByWorkflow: true,
      success: false,
      error: childResult.error || 'empty_reply',
    };
  }

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'agent_replied',
    actor: routed.employeeId || 'employee',
    payload: { replyPreview: reply.slice(0, 200) },
    businessKey: `${businessKey}:agent_replied`,
  });

  // Critic gate with bounded self-revision. A mechanically fixable block (an
  // overclaim to drop, a disclosure to add) gets up to 2 corrected drafts,
  // each re-judged from scratch by the same unmodified critic. fair_housing
  // never revises, and anything unresolved still escalates exactly as before —
  // this can only reduce human interruptions, never let something through.
  // Evidence = what the agent actually retrieved this turn. Deliberately built
  // from tool results only — the inbound customer message is NOT evidence, or a
  // prompt-injected "I already paid ₹99,999" would license the agent to state
  // that figure back as fact. See buildEvidence in reply-gate.ts.
  //
  // Retrieved memory counts as evidence too. It is the org's own curated
  // knowledge, fetched this turn by the same retrieval step that feeds the
  // prompt — every bit as much a lookup result as a tool call. Excluding it
  // meant a CORRECT answer sourced from the knowledge base ("refunds take 7
  // working days") looked like an invented figure to the grounding gate and
  // got blocked. That stayed hidden only because retrieval was returning
  // nothing at all; fixing retrieval would have exposed it immediately.
  //
  // This is not the same as trusting the inbound message: memory is written by
  // the business, the user's message is not. The injection guard above stands.
  const evidence = buildEvidence(
    childResult.executedSteps,
    // `facts` holds the snippet TEXT; `citations` holds row ids. Only the text
    // can ground a claim — passing ids would have fed the gate a list of UUIDs
    // and silently grounded nothing.
    //
    // groundingContext carries what the PLATFORM told the agent — today's date
    // and the resolved relative dates. Those are supplied facts, as grounded as
    // anything retrieved, and omitting them blocked a correct reply for saying
    // "22 Aug".
    [...(memory?.facts || []), ...(childResult.groundingContext || [])].filter(Boolean),
  );

  const critic = await criticCheckWithRevision({
    orgId: input.orgId,
    workItemId,
    draft: reply,
    intent: 'send',
    businessKey: `${businessKey}:criticCheck`,
    evidence,
  });

  // The text that actually goes out. Only trust finalDraft once allowed —
  // on a block it still holds the last rejected draft.
  const criticReply = critic.allow ? (critic.finalDraft || reply).trim() : reply;

  // Deterministic scrub for internal identifiers and self-description. The
  // prompt already forbids both, but a prompt is guidance and an injection can
  // out-argue it — this runs on the finished text no matter what the model was
  // told. See sanitiseCustomerReply in reply-gate.ts for the two real leaks
  // that motivated it.
  const sanitised = sanitiseCustomerReply(criticReply);

  // Remove any sentence that explains HOW the answer was found. The prompt
  // already forbids it and mostly complies — it slipped once in four
  // reliability runs, offering the customer a tour of the connectors and the
  // database. Guidance the model follows most of the time is not a control.
  //
  // Sentence-level, so the answer survives the edit. If nothing usable is left,
  // fall back to the neutral acknowledgement rather than shipping a fragment.
  // Placeholders first: an unresolved [current date] is the most visibly broken
  // thing a reply can contain, and removing its sentence may leave the rest
  // needing the same mechanism/preamble treatment as any other draft.
  const placeholders = stripPlaceholders(sanitised.text);
  const afterPlaceholders = placeholders.removed.length
    ? (placeholders.text.length >= 20 ? placeholders.text : HUMAN_REVIEW_REPLY)
    : sanitised.text;

  const mechanism = stripMechanismTalk(afterPlaceholders);
  const cleanedReply = mechanism.removed.length
    ? (mechanism.text.length >= 20 ? mechanism.text : HUMAN_REVIEW_REPLY)
    : afterPlaceholders;

  // Channel formatting last, so it shapes exactly what ships. On WhatsApp and
  // the shared inbox a reply is a chat message, not a document: markdown
  // headers and bullet lists render as literal `**` and `-`, and 900 characters
  // is a wall of text. Strips formatting and trims on sentence boundaries.
  // Lead with the answer. Caught by the multi-turn suite: a booking reply
  // opened "I’d be happy to help you book a showroom viewing." before any of
  // the detail asked for. Deterministic, because the prompt rule held in 21 of
  // 22 replies — close enough to be a tendency, not a control.
  const finalReply = formatForChannel(stripPreamble(cleanedReply).text, input.channel);

  // Learn from the miss. If the agent could not answer, that question goes on
  // the org's knowledge-gap list so a human can answer it ONCE and the agent
  // has it forever. Security refusals are excluded inside isKnowledgeGap —
  // "what is the other customer's number?" is correct behaviour, and listing it
  // as a gap would invite an operator to supply the answer.
  if (isKnowledgeGap(finalReply, input.userMessage)) {
    await recordKnowledgeGapActivity({
      orgId: input.orgId,
      question: input.userMessage,
      agentReply: finalReply,
      detectedVia: 'denied',
      conversationId: input.conversationId,
      workItemId,
    });
  }

  if (sanitised.modified) {
    // Audited, not silent: a draft that had to be scrubbed means the model was
    // pushed off-role, and that is worth seeing in the event stream.
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'reply_sanitised',
      actor: 'system',
      payload: {
        violations: sanitised.violations,
        disclosedInternals: sanitised.disclosedInternals,
      },
      businessKey: `${businessKey}:reply_sanitised`,
    });
  }

  if (critic.revisionsUsed > 0) {
    // Recorded whether or not it succeeded: how often revision rescues a reply
    // (and how often it fails) is exactly what tells you if this is earning
    // its latency. Pairs with the outcome ledger's human_took_over signal.
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'critic_revised',
      actor: 'system',
      payload: {
        revisionsUsed: critic.revisionsUsed,
        stopReason: critic.stopReason,
        resolved: critic.allow,
        attempts: critic.attempts,
      },
      businessKey: `${businessKey}:critic_revised`,
    });
  }

  if (!critic.allow) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: critic.reason,
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'critic_blocked',
      actor: 'system',
      payload: { policy: critic.policy, reason: critic.reason, violations: critic.violations },
      businessKey: `${businessKey}:critic_blocked`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: critic.reason },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    // Third silence path, closed. A blocked draft saved no message at all, so
    // the customer got nothing — found by reliability ×20: viewing_slot, the
    // only multi-fact answer in the suite, blocked on 1 run in 5 with "only 33%
    // of factual claims are supported by retrieved evidence" and went silent.
    //
    // The blocked draft is NOT sent — it failed the grounding or compliance bar
    // and sending it would defeat the gate. The customer gets the same neutral
    // acknowledgement used for a review timeout, and the item stays in
    // needs_attention for a human. Blocking a doubtful answer is correct;
    // answering with silence is not.
    const blockedAck = formatForChannel(HUMAN_REVIEW_REPLY, input.channel);
    if (input.conversationId) {
      await saveMessageActivity({
        orgId: input.orgId,
        conversationId: input.conversationId,
        role: 'assistant',
        content: blockedAck,
        idempotencyKey: `${businessKey}:save-critic-blocked-ack`,
      });
    }
    return {
      workItemId,
      status: nextStatus('fail'),
      replyMessage: blockedAck,
      executedSteps: childResult.executedSteps,
      savedByWorkflow: true,
      success: false,
      error: critic.reason,
    };
  }

  // Reply-class safety net only when we did not already wait before tools.
  // Leftover: agent-initiated send/pay/sign without user-message intent may
  // have already executed; this still withholds the customer-facing reply.
  const postHitl = resolveInboundHitlGate({
    userMessage: input.userMessage,
    // The approved text, so the HITL net judges what would actually be sent.
    reply: finalReply,
    executedSteps: childResult.executedSteps,
    usedTools: childResult.usedTools,
  });
  if (!preHitl.wait && postHitl.wait) {
    await updateWorkItemStatusActivity({
      orgId: input.orgId,
      workItemId,
      status: nextStatus('await_confirm'),
      conversationId: input.conversationId,
      conversationStatus: 'needs_attention',
      businessKey: `${businessKey}:status_waiting_approval`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'confirm_requested',
      actor: 'system',
      payload: { classes: postHitl.classes, phase: 'after_reply' },
      businessKey: `${businessKey}:confirm_requested`,
    });

    // Bounded wait. This used to be an unbounded condition(), and "If I change
    // my mind about an order, can I cancel it?" sat in waiting_approval
    // indefinitely: the agent had answered correctly, the answer was held for
    // review, and the customer heard nothing, ever. No error was logged because
    // nothing failed — the workflow was waiting, exactly as written.
    //
    // On expiry the held reply is NOT sent. It was flagged for review and
    // nobody reviewed it, so sending it unreviewed would defeat the gate. The
    // customer gets a neutral acknowledgement instead, and the work item stays
    // in needs_attention for the operator. Fail closed on content, fail open on
    // acknowledgement — the customer never waits on human latency.
    const approved = await condition(() => lastConfirm !== undefined, HITL_WAIT_TIMEOUT);
    if (!approved) {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: 'needs_attention',
        actor: 'system',
        payload: { reason: 'hitl_timeout', phase: 'after_reply', classes: postHitl.classes },
        businessKey: `${businessKey}:hitl_timeout_after_reply`,
      });
      const ackReply = formatForChannel(HUMAN_REVIEW_REPLY, input.channel);
      if (input.conversationId) {
        await saveMessageActivity({
          orgId: input.orgId,
          conversationId: input.conversationId,
          role: 'assistant',
          content: ackReply,
          idempotencyKey: `${businessKey}:save-hitl-timeout-ack`,
        });
      }
      return {
        workItemId,
        status: nextStatus('fail'),
        replyMessage: ackReply,
        executedSteps: childResult.executedSteps,
        savedByWorkflow: true,
        success: false,
        error: 'hitl_timeout',
      };
    }
    if (lastConfirm === 'rejected') {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: eventKindForConfirm('rejected'),
        actor: 'owner',
        payload: { decision: 'rejected', classes: postHitl.classes },
        businessKey: `${businessKey}:confirm_rejected`,
      });
      await markNeedsAttentionActivity({
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        reason: 'hitl_rejected',
        businessKey: `${businessKey}:needs_attention`,
      });
      await updateWorkItemStatusActivity({
        orgId: input.orgId,
        workItemId,
        status: nextStatus('cancel'),
        businessKey: `${businessKey}:status_cancelled`,
      });
      return {
        workItemId,
        status: nextStatus('cancel'),
        executedSteps: childResult.executedSteps,
        savedByWorkflow: true,
        success: false,
        hitlDecision: 'rejected',
        error: 'hitl_rejected',
      };
    }
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: eventKindForConfirm('approved'),
      actor: 'owner',
      payload: { decision: 'approved', classes: postHitl.classes },
      businessKey: `${businessKey}:confirm_approved`,
    });
  }

  // The reply is now cleared to send: critic allowed it, the sanitiser scrubbed
  // it, and HITL either did not apply or was approved. This is the ONLY place
  // the assistant message is written (the child runs with skipPersist), so what
  // the customer sees is exactly what passed every gate. A blocked or rejected
  // draft returns above and is never persisted as an assistant message — it
  // goes to needs_attention instead, which is where an ungated draft belongs.
  if (input.conversationId) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: finalReply,
      toolCalls: childResult.executedSteps,
      idempotencyKey: `${businessKey}:save-gated-reply`,
    });
  }

  // M4: MemoryWriteBack as a child — off the webhook HTTP thread, not awaited.
  await startChild(MemoryWriteBackWorkflow, {
    workflowId: `${parentId}-writeback`,
    args: [
      {
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        closed: false,
        toolResults: childResult.executedSteps,
        businessKey: `${businessKey}:writeBackMemory`,
      },
    ],
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    workflowExecutionTimeout: '10 minutes',
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'memory_writeback',
    actor: 'system',
    payload: { started: true, childWorkflowId: `${parentId}-writeback` },
    businessKey: `${businessKey}:memory_writeback`,
  });

  await updateWorkItemStatusActivity({
    orgId: input.orgId,
    workItemId,
    status: nextStatus('done'),
    businessKey: `${businessKey}:status_done`,
  });

  return {
    workItemId,
    status: nextStatus('done'),
    replyMessage: finalReply,
    executedSteps: childResult.executedSteps,
    savedByWorkflow: true,
    success: true,
    hitlDecision: preHitl.wait || postHitl.wait ? 'approved' : undefined,
  };
}
