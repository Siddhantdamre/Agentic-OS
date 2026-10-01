/**
 * Injectable 8-step autonomous employee loop (19).
 * Assess-first, 5-step plans, verify by reading the world back,
 * freeze after a visible partial failure — never compensate a
 * customer-visible step.
 */
import { PLAN_STEP_CAP } from './types.js';

export type LoopOutcome =
  | 'already_resolved'
  | 'parked'
  | 'executed'
  | 'escalated'
  | 'frozen'
  | 'budget_exhausted';

export interface LoopFrame {
  what: string;
  who: string;
  by?: string;
  resolved: () => boolean | Promise<boolean>;
}

export interface LoopPlanStep {
  tool: string;
  action: string;
  args: Record<string, unknown>;
  why: string;
  expect: string;
  visible?: boolean;
}

export interface LoopPlan {
  steps: LoopPlanStep[];
}

export interface LoopGateVerdict {
  mode: 'execute' | 'approval_required';
  reasonCode: string;
}

export interface LoopExecuteResult {
  ok: boolean;
  visible?: boolean;
  transient?: boolean;
}

export interface LoopLedgerRow {
  decision: string;
  reasonCode: string;
}

export interface EmployeeLoopDeps {
  planner: (frame: LoopFrame) => Promise<LoopPlan>;
  gate: (step: LoopPlanStep) => Promise<LoopGateVerdict>;
  execute: (step: LoopPlanStep) => Promise<LoopExecuteResult>;
  verify: (step: LoopPlanStep) => Promise<boolean>;
  retrieve?: (frame: LoopFrame) => Promise<unknown>;
  ledger?: (row: LoopLedgerRow) => Promise<void> | void;
  assess?: (frame: LoopFrame) => Promise<boolean | { resolved: boolean; reason?: string }>;
}

export interface EmployeeLoopResult {
  outcome: LoopOutcome;
  reasonCode: string;
  modelCalls: number;
  completed: LoopPlanStep[];
  frozenAfter?: LoopPlanStep;
}

export async function runEmployeeLoop(input: {
  frame: LoopFrame;
  planner: EmployeeLoopDeps['planner'];
  gate: EmployeeLoopDeps['gate'];
  execute: EmployeeLoopDeps['execute'];
  verify: EmployeeLoopDeps['verify'];
  retrieve?: EmployeeLoopDeps['retrieve'];
  ledger?: EmployeeLoopDeps['ledger'];
  assess?: EmployeeLoopDeps['assess'];
  modelCallBudget?: number;
}): Promise<EmployeeLoopResult> {
  const modelCallBudget = input.modelCallBudget ?? 8;
  let modelCalls = 0;
  const completed: LoopPlanStep[] = [];
  const writeLedger = async (row: LoopLedgerRow) => {
    await input.ledger?.(row);
  };

  // Step 3 — Assess first: SQL-first / predicate check before ANY model calls (19 §1)
  if (input.assess) {
    const assessed = await input.assess(input.frame);
    const isResolved = typeof assessed === 'boolean' ? assessed : assessed.resolved;
    if (isResolved) {
      const reasonCode = (typeof assessed === 'object' && assessed.reason) || 'already_resolved';
      await writeLedger({ decision: 'executed', reasonCode });
      return { outcome: 'already_resolved', reasonCode, modelCalls: 0, completed };
    }
  }

  if (await input.frame.resolved()) {
    await writeLedger({ decision: 'executed', reasonCode: 'already_resolved' });
    return { outcome: 'already_resolved', reasonCode: 'already_resolved', modelCalls: 0, completed };
  }

  if (input.retrieve) {
    modelCalls += 1;
    if (modelCalls > modelCallBudget) {
      await writeLedger({ decision: 'declined', reasonCode: 'budget_exhausted' });
      return { outcome: 'budget_exhausted', reasonCode: 'budget_exhausted', modelCalls, completed };
    }
    await input.retrieve(input.frame);
  }

  modelCalls += 1;
  if (modelCalls > modelCallBudget) {
    await writeLedger({ decision: 'declined', reasonCode: 'budget_exhausted' });
    return { outcome: 'budget_exhausted', reasonCode: 'budget_exhausted', modelCalls, completed };
  }
  const plan = await input.planner(input.frame);
  if (plan.steps.length > PLAN_STEP_CAP) {
    await writeLedger({ decision: 'escalated', reasonCode: 'budget_exhausted' });
    return { outcome: 'budget_exhausted', reasonCode: 'budget_exhausted', modelCalls, completed };
  }

  for (const step of plan.steps) {
    const verdict = await input.gate(step);
    if (verdict.mode === 'approval_required') {
      await writeLedger({ decision: 'deferred', reasonCode: verdict.reasonCode });
      return { outcome: 'parked', reasonCode: verdict.reasonCode, modelCalls, completed };
    }

    const acted = await input.execute(step);
    if (!acted.ok) {
      const visiblePartial = completed.some((s) => s.visible) || acted.visible === true;
      if (visiblePartial) {
        await writeLedger({ decision: 'escalated', reasonCode: 'partial_failure_frozen' });
        return {
          outcome: 'frozen',
          reasonCode: 'partial_failure_frozen',
          modelCalls,
          completed,
          frozenAfter: step,
        };
      }
      await writeLedger({ decision: 'escalated', reasonCode: 'verification_failed' });
      return { outcome: 'escalated', reasonCode: 'verification_failed', modelCalls, completed };
    }

    const verified = await input.verify(step);
    if (!verified) {
      await writeLedger({ decision: 'declined', reasonCode: 'verification_failed' });
      return { outcome: 'escalated', reasonCode: 'verification_failed', modelCalls, completed };
    }
    completed.push({ ...step, visible: step.visible ?? acted.visible });
  }

  await writeLedger({ decision: 'executed', reasonCode: 'executed' });
  return { outcome: 'executed', reasonCode: 'executed', modelCalls, completed };
}
