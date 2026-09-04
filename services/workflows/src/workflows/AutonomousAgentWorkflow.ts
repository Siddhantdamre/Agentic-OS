/**
 * SUPERVISION: GAP — THE LARGEST ONE. Every standing duty and every inbound
 * customer reply runs through here, and none of it reports the
 * doer/monitor/learner trio. Measured on this database: 807 rows in
 * agent_actions, 1 in task_supervision. Outcomes ARE recorded - the ledger,
 * the reply gate and the empty-result check all apply - but no monitor
 * judges the reply after the fact. Closing this means a second model call
 * per run, which is a cost decision an operator has to make, not a fix to
 * slip in.
 */
import { proxyActivities, defineQuery, setHandler } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { computeTurnBudget, evaluateTurnProgress } from '../turn-budget.js';

const { runAgentTurnActivity, saveMessageActivity, logChannelActivity } = proxyActivities<typeof activities>({
  // 12 min covers multi-tool chains (Gmail + Calendar + HubSpot + WhatsApp).
  // scheduleToClose caps the absolute wall-clock budget including retries.
  startToCloseTimeout: '12 minutes',
  scheduleToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '5s',
    maximumAttempts: 2,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

export const agentProgressQuery = defineQuery<AgentTaskResult['executedSteps']>('agentProgressQuery');

export async function AutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  // atomic-agent already runs a complete MCP tool loop per turn. This workflow
  // is the durable wrapper: one primary turn, then at most two retries when
  // the turn timed out or returned no reply after tools. priorToolResults is
  // fed back into the next turn so the model does not blindly re-run work.

  // Adaptive turn budget. computeTurnBudget is a PURE function of the input —
  // no clock, no randomness, no I/O — so this stays deterministic under
  // Temporal replay. "thanks!" gets 1 turn; a three-part request gets up to 6.
  // An unreadable message yields the old fixed value, so a signal bug degrades
  // to today's behaviour rather than to zero turns. See turn-budget.ts.
  const budget = computeTurnBudget(input.userMessage || '', input.toolAllowlist || []);
  const MAX_TURNS = budget.turns;

  let currentInput: AgentTaskInput = { ...input };
  let finalResult: AgentTaskResult | null = null;
  const allExecutedSteps: AgentTaskResult['executedSteps'] = [];
  const allUsedTools = new Set<string>();
  let finalReplyMessage = '';
  let stoppedEarlyForNoProgress = false;
  let turnsUsed = 0;

  setHandler(agentProgressQuery, () => allExecutedSteps);

  for (let step = 1; step <= MAX_TURNS; step++) {
    turnsUsed = step;
    // Snapshot before the turn so "new" is measured against everything seen so
    // far, not just the previous turn.
    const toolsBeforeTurn = new Set(allUsedTools);
    const stepsBeforeTurn = allExecutedSteps.length;

    const result = await runAgentTurnActivity(currentInput);

    allExecutedSteps.push(...result.executedSteps);
    for (const tool of result.usedTools) {
      allUsedTools.add(tool);
    }

    if (result.replyMessage) {
      finalReplyMessage = result.replyMessage;
    }

    finalResult = {
      ...result,
      replyMessage: finalReplyMessage,
      executedSteps: allExecutedSteps,
      usedTools: Array.from(allUsedTools),
    };

    const shouldContinue =
      result.retryable === true ||
      (result.success && !result.isDone && !result.replyMessage && result.usedTools.length > 0);

    if (!shouldContinue || step === MAX_TURNS) {
      break;
    }

    // Stuck detection. A bigger budget is permission to continue, not an
    // obligation: the existing condition above only asks "did it use tools?",
    // which stays true while an agent re-runs the same failing call. If a turn
    // surfaced no new tool AND no new step, more turns will not help — stop and
    // keep the budget rather than spending it repeating ourselves.
    // Retryable turns are exempt: a timeout legitimately produces nothing new.
    const progress = evaluateTurnProgress(
      toolsBeforeTurn,
      result.usedTools,
      allExecutedSteps.length - stepsBeforeTurn
    );
    if (!progress.madeProgress && result.retryable !== true) {
      stoppedEarlyForNoProgress = true;
      break;
    }

    currentInput = {
      ...currentInput,
      priorToolResults: allExecutedSteps,
    };
  }

  /**
   * A run that produced nothing is not a success.
   *
   * The activity's verdict used to pass through untouched, and it reported
   * `success: true` with an empty reply and an empty tool list. Found on a real
   * shift run: Aisha's duty completed, claimed success, used no tool and said
   * nothing. An operator reading that sees a green tick under an employee that
   * did not do its job — which is the one failure mode this system treats as
   * worse than an outage, because it is the only one that actively misleads.
   *
   * ADR 3 says silence is never recorded as success. That was enforced on the
   * customer reply path in WorkItemWorkflow and not here, so Ask AI and every
   * shift inherited the hole.
   *
   * The two empty cases are separated because they need different responses. No
   * reply and no tools means nothing happened at all — usually a prompt the
   * model could not act on. No reply but tools ran means work occurred and went
   * unreported, which is a reporting bug rather than an idle agent, and the
   * executed steps are still there to inspect.
   */
  const raw = finalResult!;
  const producedNothing = !String(raw.replyMessage || '').trim();
  const resultToSave: AgentTaskResult = producedNothing
    ? {
      ...raw,
      success: false,
      error: raw.error
        || (raw.usedTools.length === 0
          ? 'the agent produced no reply and used no tool — nothing was attempted'
          : `the agent used ${raw.usedTools.join(', ')} but reported no result`),
    }
    : raw;

  if (input.orgId) {
    await logChannelActivity({
      orgId: input.orgId,
      channelId: input.channelId,
      logType: 'AGENT_EXECUTION',
      payload: {
        employeeName: input.employeeName,
        // The id, not just the name. The outcome ledger attributes an action to
        // an employee by id; with only a name it had nothing to join on, so
        // every shift an employee ran was recorded here and appeared nowhere on
        // that employee's own page. Two employees can also share a name — there
        // are 52 rows called "Sarah" in this database — so a name is not an
        // identity even when it looks like one.
        employeeId: input.employeeId ?? null,
        // Carried so the ledger can tell a duty from a customer reply without
        // re-deriving it: a shift skips message persistence by design.
        selfDirected: Boolean(input.skipPersist),
        succeeded: resultToSave.success,
        usedTools: resultToSave.usedTools,
        stepsCount: resultToSave.executedSteps.length,
        engine: 'atomic-agent',
        // Budget telemetry. Granted vs. actually used is what proves the
        // heuristic earns its keep: if tasks routinely exhaust their budget,
        // the ceiling is too low; if they never approach it, it is too high.
        // `stoppedEarlyForNoProgress` isolates genuinely stuck runs from ones
        // that simply finished.
        turnBudget: budget.turns,
        turnBudgetReason: budget.reason,
        turnsUsed,
        stoppedEarlyForNoProgress,
        /**
         * THE REPORT THE DUTY WAS RUN TO PRODUCE.
         *
         * A duty sets `skipPersist` because it is not a customer conversation
         * and must never be written into `messages`. That was read as "discard
         * the output", so the reply was thrown away and only telemetry
         * survived: four employees ran 3-8 tool steps each and the record of it
         * was "Emma, 8 steps, succeeded". The employee page, whose whole job is
         * showing what an employee did, could show a count and nothing else.
         *
         * The work happened. Nobody could read it. That is indistinguishable
         * from the work not happening, and worse, because it costs the tokens
         * either way.
         *
         * Kept here rather than in `messages` — a morning report addressed to
         * the owner is not a message to a customer — and capped, because a
         * runaway reply must not bloat every log row.
         */
        report: input.skipPersist ? String(resultToSave.replyMessage || '').slice(0, 4000) : undefined,
      },
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:log` : undefined,
    });
  }

  if (input.conversationId && input.orgId && resultToSave.replyMessage && !input.skipPersist) {
    await saveMessageActivity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: resultToSave.replyMessage,
      toolCalls: resultToSave.executedSteps,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:save` : undefined,
    });
  }

  return resultToSave;
}
