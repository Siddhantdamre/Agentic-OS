/**
 * Should this workspace's agent stop asking, for this kind of action?
 *
 * Today (migration 034) the answer is a streak: ten approvals in a row and a
 * class of action graduates from `ask` to `notify`, one rejection sends it back.
 * That rule is honest and safe, and it has two costs. Every workspace starts
 * cold and pays the full ten approvals for actions every other workspace has
 * already shown to be safe. And ten in a row is weak evidence: an action a
 * workspace would approve only 80% of the time passes it about one time in ten.
 *
 * This module replaces the streak with a posterior, and lets other workspaces'
 * experience count as a PRIOR — bounded, opt-in, and never a substitute for
 * the workspace's own evidence.
 *
 * THE RULE, in words
 *   A class may graduate only if
 *     (a) it is allowed to graduate at all (send / publish / price; never pay,
 *         sign, legal, pack_banned — unchanged from migration 034), and
 *     (b) this workspace has itself seen at least `minLocalApprovals` approvals, and
 *     (c) the posterior puts at least 1 - delta of its mass at or above tau
 *         (the approval rate is, with confidence, high enough), and
 *     (d) if the hive urges CAUTION, the stricter local test below is met instead.
 *   The posterior is Beta(1 + local approvals + prior approvals,
 *                          1 + local rejections + prior rejections)
 *   with the hive prior scaled down to at most `maxPriorWeight` pseudo-observations.
 *
 * WHAT THE HIVE CAN AND CANNOT DO
 *   It can make a workspace graduate sooner, by no more than the local floor allows.
 *   It can urge CAUTION when the cohort's experience says the action is usually
 *   rejected: the prior is dropped and the workspace must clear a stricter test on
 *   its OWN evidence (more approvals, higher confidence). Safety flows in at full
 *   strength, but it is a demand for proof, not a lock: the first design was an
 *   outright veto, and simulation showed twenty colluding workspaces contributing
 *   only rejections could keep every safe workspace asking forever. A caution
 *   can be answered with evidence; a veto could only be waited out.
 *   It can NOT graduate an action class that is not graduatable, can NOT skip the
 *   local floor, and is switched OFF for a class after this workspace's own
 *   rejection: after your own "no", you earn it back on your own evidence.
 *
 * Everything below is exact rational arithmetic (see beta.ts); the receipt it
 * returns contains every number needed to re-derive the decision.
 */
import { Q, fromDecimal, toString as qs, toDecimal, lte, gte, ONE, sub } from './rational';
import { betaCdf } from './beta';
import { isReleased, type Release } from './privacy';

export interface TrustPolicy {
  /** The approval rate we want the class to clear. */
  tau: Q;
  /** Tolerated probability that the true rate is below tau. */
  delta: Q;
  /** Local approvals required whatever the prior says. */
  minLocalApprovals: number;
  /** Cap on the hive prior's weight, in pseudo-observations. */
  maxPriorWeight: number;
  /** The cohort rate below which the hive urges caution. */
  vetoTau: Q;
  /** Confidence needed: P(cohort rate < vetoTau) >= 1 - vetoDelta. */
  vetoDelta: Q;
  /**
   * Caution needs at least this many released observations. The released counts
   * carry noise of a size set by epsilon and clip; a signal driven by a total
   * that small is driven by the noise. Missing a caution only means the ordinary
   * rule applies, which is still safe, so the floor costs little.
   */
  vetoMinObservations: number;
  /** Under caution: local approvals required. */
  cautionMinLocalApprovals: number;
  /** Under caution: tolerated probability that the true rate is below tau (stricter than delta). */
  cautionDelta: Q;
}

/**
 * Defaults, chosen against the WORST case rather than the average (experiment E7
 * in sim.ts). The prior's weight cap and the local floor are one knob: the same
 * setting that lets an honest hive speed a workspace up lets a poisoned one push
 * a risky class through. Measured over 1,000 new workspaces per cell, with a
 * 3,000-workspace approve-only coalition:
 *
 *                       safe-class speedup     unsafe graduations if poisoned
 *   no hive                     1.0x                     5%
 *   CONSERVATIVE (8, 8)         1.1x                     6%
 *   DEFAULT      (8, 5)         1.7x                    13%
 *   ACCELERATED (12, 3)         2.0x                    26%
 *   today's streak rule                                 41%   (on the same stream)
 *
 * DEFAULT is the middle row: a real speedup, and even under a coalition thirty
 * times the size of the honest hive it is about three times safer than the rule
 * it replaces. ACCELERATED is appropriate only where participation is verified
 * (paid, aged, active workspaces) so that such a coalition is not cheap to build.
 */
export const DEFAULT_POLICY: TrustPolicy = {
  tau: fromDecimal('0.9'),
  delta: fromDecimal('0.35'),
  minLocalApprovals: 5,
  maxPriorWeight: 8,
  vetoTau: fromDecimal('0.8'),
  vetoDelta: fromDecimal('0.05'),
  vetoMinObservations: 60,
  cautionMinLocalApprovals: 20,
  cautionDelta: fromDecimal('0.1'),
};

export const CONSERVATIVE_POLICY: TrustPolicy = { ...DEFAULT_POLICY, minLocalApprovals: 8, maxPriorWeight: 8 };
export const ACCELERATED_POLICY: TrustPolicy = { ...DEFAULT_POLICY, minLocalApprovals: 3, maxPriorWeight: 12 };

export interface LocalEvidence {
  approvals: number;
  /** Rejections by this workspace's own people since it last reset. */
  rejections: number;
  /** True after a local rejection: the hive prior is ignored until the class is re-earned. */
  lockedOut: boolean;
}

export interface HiveInput {
  optedIn: boolean;
  release: Release | null;
}

export type Verdict = 'graduate' | 'hold';

export interface Decision {
  verdict: Verdict;
  /** Why, in one machine-stable word. */
  reason:
    | 'not_graduatable'
    | 'needs_local_evidence'
    | 'hive_caution'
    | 'posterior_insufficient'
    | 'posterior_sufficient';
  posterior: { alpha: number; beta: number };
  /** P(rate < tau) under the posterior, exact ("a/b"). */
  pBelowTau: string;
  /** The threshold it was compared to. */
  delta: string;
  prior: { used: boolean; approvals: number; rejections: number; weight: number; source: 'none' | 'hive' };
  veto: { evaluated: boolean; pCohortBelowVetoTau: string | null; triggered: boolean };
  /** True when the stricter local-only test was applied because the cohort urged caution. */
  cautious: boolean;
  policy: { tau: string; delta: string; minLocalApprovals: number; maxPriorWeight: number; vetoTau: string; vetoDelta: string; vetoMinObservations: number; cautionMinLocalApprovals: number; cautionDelta: string };
  local: LocalEvidence;
}

/** The hive prior as integer pseudo-counts, capped in weight. */
export function hivePrior(release: Release | null, maxWeight: number): { approvals: number; rejections: number; weight: number } {
  if (!isReleased(release)) return { approvals: 0, rejections: 0, weight: 0 };
  const total = release.approvals + release.rejections;
  if (total <= 0) return { approvals: 0, rejections: 0, weight: 0 };
  const weight = Math.min(total, Math.max(0, Math.trunc(maxWeight)));
  // Round half up in integers so the split is exact and reproducible.
  const a = Math.floor((2 * weight * release.approvals + total) / (2 * total));
  return { approvals: a, rejections: weight - a, weight };
}

/** The decision as exact numbers, with no string conversion. `decide` wraps this; the simulation calls it millions of times. */
export interface Evaluation {
  verdict: Verdict;
  reason: Decision['reason'];
  alpha: number;
  beta: number;
  pBelow: Q;
  delta: Q;
  prior: { approvals: number; rejections: number; weight: number };
  veto: { evaluated: boolean; pCohortBelowVetoTau: Q | null; triggered: boolean };
  cautious: boolean;
}

export function evaluate(input: {
  graduatable: boolean;
  local: LocalEvidence;
  hive: HiveInput;
  policy?: TrustPolicy;
}): Evaluation {
  const policy = input.policy ?? DEFAULT_POLICY;
  const { local, hive } = input;
  const release = hive.optedIn ? hive.release : null;

  // Caution reads the FULL released counts, not the weight-capped prior: bad
  // news from the cohort is never diluted. It applies even after a local lockout.
  let veto = { evaluated: false, pCohortBelowVetoTau: null as Q | null, triggered: false };
  if (isReleased(release) && release.approvals + release.rejections >= policy.vetoMinObservations) {
    const pc = betaCdf(1 + release.approvals, 1 + release.rejections, policy.vetoTau);
    veto = { evaluated: true, pCohortBelowVetoTau: pc, triggered: gte(pc, sub(ONE, policy.vetoDelta)) };
  }
  const cautious = veto.triggered;

  // Under caution the cohort is not a prior at all: it has told us this kind of
  // action is usually rejected, so the workspace stands on its own evidence,
  // held to a stricter standard.
  const prior = !local.lockedOut && !cautious ? hivePrior(release, policy.maxPriorWeight) : { approvals: 0, rejections: 0, weight: 0 };
  const alpha = 1 + local.approvals + prior.approvals;
  const beta = 1 + local.rejections + prior.rejections;
  const pBelow = betaCdf(alpha, beta, policy.tau);
  const delta = cautious ? (lte(policy.cautionDelta, policy.delta) ? policy.cautionDelta : policy.delta) : policy.delta;
  const floor = cautious ? Math.max(policy.minLocalApprovals, policy.cautionMinLocalApprovals) : policy.minLocalApprovals;

  const done = (verdict: Verdict, reason: Decision['reason']): Evaluation => ({ verdict, reason, alpha, beta, pBelow, delta, prior, veto, cautious });
  if (!input.graduatable) return done('hold', 'not_graduatable');
  if (local.approvals < floor) return done('hold', cautious ? 'hive_caution' : 'needs_local_evidence');
  if (lte(pBelow, delta)) return done('graduate', 'posterior_sufficient');
  return done('hold', cautious ? 'hive_caution' : 'posterior_insufficient');
}

export function decide(input: {
  graduatable: boolean;
  local: LocalEvidence;
  hive: HiveInput;
  policy?: TrustPolicy;
}): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  const e = evaluate(input);
  return {
    verdict: e.verdict,
    reason: e.reason,
    posterior: { alpha: e.alpha, beta: e.beta },
    pBelowTau: qs(e.pBelow),
    delta: qs(e.delta),
    prior: { used: e.prior.weight > 0, approvals: e.prior.approvals, rejections: e.prior.rejections, weight: e.prior.weight, source: e.prior.weight > 0 ? 'hive' : 'none' },
    veto: { evaluated: e.veto.evaluated, pCohortBelowVetoTau: e.veto.pCohortBelowVetoTau ? qs(e.veto.pCohortBelowVetoTau) : null, triggered: e.veto.triggered },
    cautious: e.cautious,
    policy: {
      tau: qs(policy.tau), delta: qs(policy.delta), minLocalApprovals: policy.minLocalApprovals,
      maxPriorWeight: policy.maxPriorWeight, vetoTau: qs(policy.vetoTau), vetoDelta: qs(policy.vetoDelta),
      vetoMinObservations: policy.vetoMinObservations,
      cautionMinLocalApprovals: policy.cautionMinLocalApprovals, cautionDelta: qs(policy.cautionDelta),
    },
    local: input.local,
  };
}

/** The rule this replaces, kept as the comparison arm: N approvals in a row, reset by any rejection. */
export function streakRule(consecutiveApprovals: number, threshold = 10): boolean {
  return consecutiveApprovals >= threshold;
}

export { toDecimal };
