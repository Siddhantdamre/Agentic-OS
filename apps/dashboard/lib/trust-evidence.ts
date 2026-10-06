/**
 * Evidence for "how far can this team be trusted to act alone?".
 *
 * Pure functions only: the numbers come in from trust-query.ts (measured in
 * the database, never supplied by a browser) and a recommendation comes out.
 *
 * What is NOT here on purpose: anything that guesses. A rate with no decisions
 * behind it is null, never 0% or 100%. A small sample is labelled too small
 * to judge. Undone actions and complaints are only discussed when something
 * records them (outcomesTracked), because a table nobody writes to would
 * otherwise read as "no problems".
 */
import { stageRequirements, type RolloutStage, type StageRequirement, type StageRequirementId } from './employee-rollout';

/** Fewer decisions than this is an anecdote, not a track record. */
export const MIN_DECIDED_TO_JUDGE = 10;

/**
 * When to suggest going back a level. Starting values: the approval floor is the
 * lower edge of the health band the workspace already uses, the rest are
 * conservative guesses that no production data has tuned yet.
 */
export const PULL_BACK = {
  minDecided: 20,
  approvalBelow: 0.6,
  failedMin: 3,
  failedShare: 0.2,
  expiredMin: 3,
  expiredShare: 0.3,
  minCarriedOut: 10,
  problemRateAtLeast: 0.1,
} as const;

export interface EmployeeCounts {
  /** Parked for a person and approved without changes. */
  approvedAsIs: number;
  /** Approved after the person changed it first. */
  approvedEdited: number;
  rejected: number;
  /** Nobody answered in time. Not the employee's doing, so it is not in any rate. */
  expired: number;
  waiting: number;
  /** Approved by a person, then failed when it ran. A subset of the approved. */
  failedToRun: number;
  /** Actions that were actually carried out. */
  carriedOut: number;
  /** Carried-out actions later undone or complained about. Only meaningful when outcomesTracked. */
  withProblems: number;
  /** True only when something records undo and complaint signals for this workspace. */
  outcomesTracked: boolean;
  lastDecisionAt: string | null;
}

export type Concern = 'many_turned_down' | 'often_fails' | 'approvals_expiring' | 'often_undone';

export interface EmployeeEvidence extends EmployeeCounts {
  decided: number;
  approvalRate: number | null;
  asIsRate: number | null;
  enough: boolean;
  stillNeeded: number;
  problemRate: number | null;
  concerns: Concern[];
}

function count(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function ratio(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

export function summariseEmployee(input: EmployeeCounts): EmployeeEvidence {
  const approvedAsIs = count(input.approvedAsIs);
  const approvedEdited = count(input.approvedEdited);
  const rejected = count(input.rejected);
  const expired = count(input.expired);
  const failedToRun = count(input.failedToRun);
  const carriedOut = count(input.carriedOut);
  const withProblems = count(input.withProblems);

  const approved = approvedAsIs + approvedEdited;
  const decided = approved + rejected;
  const approvalRate = ratio(approved, decided);
  const enough = decided >= MIN_DECIDED_TO_JUDGE;
  const problemRate = input.outcomesTracked ? ratio(withProblems, carriedOut) : null;

  const concerns: Concern[] = [];
  if (decided >= PULL_BACK.minDecided && approvalRate !== null && approvalRate < PULL_BACK.approvalBelow) {
    concerns.push('many_turned_down');
  }
  if (failedToRun >= PULL_BACK.failedMin && approved > 0 && failedToRun / approved >= PULL_BACK.failedShare) {
    concerns.push('often_fails');
  }
  const asked = decided + expired;
  if (expired >= PULL_BACK.expiredMin && asked > 0 && expired / asked >= PULL_BACK.expiredShare) {
    concerns.push('approvals_expiring');
  }
  if (problemRate !== null && carriedOut >= PULL_BACK.minCarriedOut && problemRate >= PULL_BACK.problemRateAtLeast) {
    concerns.push('often_undone');
  }

  return {
    ...input,
    approvedAsIs, approvedEdited, rejected, expired, failedToRun, carriedOut, withProblems,
    waiting: count(input.waiting),
    decided,
    approvalRate,
    asIsRate: ratio(approvedAsIs, decided),
    enough,
    stillNeeded: Math.max(0, MIN_DECIDED_TO_JUDGE - decided),
    problemRate,
    concerns,
  };
}

export interface WorkspaceEvidence {
  stage: RolloutStage;
  killSwitch: boolean;
  weeksInStage: number;
  stateDivergences: number;
  shadowReviewed: number;
  shadowAgreed: number;
  /** Decisions a person made since the workspace entered this stage. */
  decisionsInStage: number;
  /** Approved share of those decisions; null when there are none. */
  approvalRate: number | null;
  /** The same over a recent window, used to decide whether to pull back. */
  recentDecided: number;
  recentApprovalRate: number | null;
}

export type RecommendationKind = 'advance' | 'hold' | 'pull_back' | 'steady';
export type ReasonId = StageRequirementId | 'paused' | 'recent_approval_low';

export interface Recommendation {
  kind: RecommendationKind;
  reasons: ReasonId[];
  requirements: StageRequirement[];
}

export function recommendStage(e: WorkspaceEvidence): Recommendation {
  const requirements = stageRequirements({
    from: e.stage,
    shadowReviewed: e.shadowReviewed,
    shadowAgreed: e.shadowAgreed,
    weeksInStage: e.weeksInStage,
    stateDivergences: e.stateDivergences,
    approvalRate: e.approvalRate,
    decisionsInStage: e.decisionsInStage,
  });

  if (e.killSwitch) return { kind: 'hold', reasons: ['paused'], requirements };

  const recentlyPoor =
    e.stage >= 1 &&
    e.recentDecided >= PULL_BACK.minDecided &&
    e.recentApprovalRate !== null &&
    e.recentApprovalRate < PULL_BACK.approvalBelow;
  if (recentlyPoor) return { kind: 'pull_back', reasons: ['recent_approval_low'], requirements };

  if (e.stage === 3) return { kind: 'steady', reasons: [], requirements };

  const unmet = requirements.filter((r) => !r.met).map((r) => r.id);
  return unmet.length === 0
    ? { kind: 'advance', reasons: [], requirements }
    : { kind: 'hold', reasons: unmet, requirements };
}
