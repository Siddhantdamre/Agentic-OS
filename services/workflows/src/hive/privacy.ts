/**
 * What may leave a tenant, and in what form.
 *
 * The hive learns from many workspaces how often each KIND of action was
 * approved or rejected. It never sees, stores or releases anything else: no
 * content, no recipients, no identifiers. What crosses the boundary is a pair of
 * counts per (action class, cohort), and even those cross only after four
 * protections, each of which is enforced in this file and again, independently,
 * in SQL (migration 348), because a privacy guarantee that lives in one language
 * is one refactor from being false.
 *
 *   1. OPT-IN.       A workspace contributes nothing until it says so, and only
 *                    a contributing workspace receives a prior (reciprocity).
 *   2. CLIPPING.     Each workspace's TOTAL (approvals + rejections) is capped
 *                    at `clip` before it is summed, by scaling both counts down
 *                    in proportion (with deterministic randomised rounding, so
 *                    the rate is preserved in expectation and a rare rejection
 *                    is not rounded away). No single workspace can move the
 *                    aggregate by more than `clip` in L1, which is what bounds
 *                    both privacy loss (sensitivity) and poisoning power.
 *                    Capping each count separately was tried first and
 *                    rejected: 29 approvals and 1 rejection became 10 and 1,
 *                    which biases the cohort's rate downward.
 *   3. k-THRESHOLD.  Nothing is released for a cell with fewer than `k`
 *                    contributing workspaces. Below k the answer is "not enough
 *                    workspaces", never a small, revealing number.
 *   4. NOISE.        Discrete Laplace noise of scale clip / epsilon is added to
 *                    each of the two counts. The pair has L1 sensitivity
 *                    `clip`, so this is epsilon-DP for the pair, not 2 x epsilon. It is derived deterministically
 *                    from a secret key and the release label, so a release is
 *                    computed ONCE: asking again returns the same number, and
 *                    an adversary cannot average the noise away by repeating
 *                    the query. (Fresh randomness per query would be the
 *                    classic way to turn a differentially private system into
 *                    a non-private one.)
 *
 * WHAT THIS DOES NOT CLAIM
 * It is epsilon-differential privacy for one workspace's contribution to ONE
 * release, under basic composition across releases (see `epochEpsilon`). It is
 * not a proof about the end-to-end system, it uses floating point in the noise
 * sampler (the output is an integer, which avoids the worst of the well-known
 * floating-point Laplace attacks but is not a substitute for a reviewed
 * sampler), and it needs an independent privacy review before real customer
 * data flows through it.
 */
import { createHmac } from 'node:crypto';

export interface Contribution {
  orgId: string;
  optedIn: boolean;
  approvals: number;
  rejections: number;
}

export interface ReleaseParams {
  /** Minimum number of distinct contributing workspaces. */
  k: number;
  /** Per-workspace cap on approvals + rejections (the L1 sensitivity). */
  clip: number;
  /** Privacy budget for this release, for one workspace's contribution to the pair of counts. */
  epsilon: number;
  /** Secret key. Never released; makes the noise unpredictable and the release reproducible. */
  key: Buffer | string;
  /** Names the release, e.g. `${actionClass}|${cohort}|${epoch}`. */
  label: string;
}

export interface ReleasedCounts {
  suppressed: false;
  /** Noisy, clamped, integer. */
  approvals: number;
  rejections: number;
  /** Only the fact that the threshold was met is released, not how far it was exceeded. */
  atLeastK: number;
  epsilon: number;
  clip: number;
}

export interface SuppressedRelease {
  suppressed: true;
  reason: 'below_k';
  k: number;
}

export type Release = SuppressedRelease | ReleasedCounts;

/** True for a real release. A predicate, because this package compiles with strict:false, where a boolean discriminant does not narrow. */
export function isReleased(r: Release | null | undefined): r is ReleasedCounts {
  return !!r && r.suppressed === false;
}

/**
 * Cap a workspace's total at `c`, keeping its approval rate.
 *
 * Scaling is a * c / (a + r), rounded down, then rounded UP with probability
 * equal to the fractional part, using a uniform derived from the secret key, the
 * release label and the workspace id. So the result is deterministic for one
 * release (the same inputs give the same output), unbiased across workspaces,
 * and its rounding cannot be predicted without the key. The two outputs always
 * sum to exactly c once clipping applies.
 */
export function clipPair(a: number, r: number, c: number, key: Buffer | string, label: string, orgId: string): [number, number] {
  const A = Math.max(0, Math.trunc(a));
  const R = Math.max(0, Math.trunc(r));
  const t = A + R;
  if (t <= c) return [A, R];
  // Exact integer arithmetic: A * c may exceed 2^53 only for absurd counts; BigInt keeps it exact regardless.
  const num = BigInt(A) * BigInt(c);
  const den = BigInt(t);
  const whole = Number(num / den);
  const rem = Number(num % den) / Number(den);
  const u = uniform(key, `${label}|clip|${orgId}`, 0);
  const a2 = whole + (u <= rem ? 1 : 0);
  return [Math.min(a2, c), c - Math.min(a2, c)];
}

/** Uniform in (0, 1], 48 bits, from HMAC-SHA256(key, label:index). */
function uniform(key: Buffer | string, label: string, index: number): number {
  const h = createHmac('sha256', key).update(`${label}:${index}`).digest();
  const v = h.readUIntBE(0, 6); // 48 bits, exact in a double
  return (v + 1) / 2 ** 48;
}

/**
 * Two-sided geometric ("discrete Laplace") noise with P(Z = z) proportional to
 * alpha^|z|, alpha = exp(-epsilon / sensitivity). Z = G1 - G2 with
 * G ~ Geometric(1 - alpha) counting failures.
 */
export function geometricNoise(key: Buffer | string, label: string, epsilon: number, sensitivity: number): number {
  if (!(epsilon > 0)) throw new RangeError('epsilon must be > 0');
  if (!(sensitivity >= 1)) throw new RangeError('sensitivity must be >= 1');
  const lnAlpha = -epsilon / sensitivity;
  const g = (i: number) => Math.floor(Math.log(uniform(key, label, i)) / lnAlpha);
  return g(0) - g(1);
}

/**
 * Build one release from the workspaces' contributions.
 * Pure and deterministic in its inputs: the same contributions and label return
 * the same release, which is what makes repeating the query useless to an attacker.
 */
export function makeRelease(contributions: Contribution[], p: ReleaseParams): Release {
  if (!(p.k >= 1)) throw new RangeError('k must be >= 1');
  if (!(p.clip >= 1)) throw new RangeError('clip must be >= 1');

  // One contribution per workspace: a workspace listed twice must not count twice.
  const byOrg = new Map<string, Contribution>();
  for (const c of contributions) {
    if (!c.optedIn) continue;
    const prev = byOrg.get(c.orgId);
    byOrg.set(c.orgId, prev ? { ...c, approvals: prev.approvals + c.approvals, rejections: prev.rejections + c.rejections } : c);
  }
  if (byOrg.size < p.k) return { suppressed: true, reason: 'below_k', k: p.k };

  let A = 0;
  let R = 0;
  for (const c of byOrg.values()) {
    const [a, r] = clipPair(c.approvals, c.rejections, p.clip, p.key, p.label, c.orgId);
    A += a;
    R += r;
  }
  // L1 sensitivity of the pair is `clip`, so scale clip / epsilon on each is epsilon-DP for the pair.
  const nA = geometricNoise(p.key, `${p.label}|A`, p.epsilon, p.clip);
  const nR = geometricNoise(p.key, `${p.label}|R`, p.epsilon, p.clip);
  return {
    suppressed: false,
    approvals: Math.max(0, A + nA),
    rejections: Math.max(0, R + nR),
    atLeastK: p.k,
    epsilon: p.epsilon,
    clip: p.clip,
  };
}

/**
 * Basic composition: a workspace that contributes to `classes` action classes in
 * one epoch has spent classes x epsilon. Reported, not enforced here; the SQL
 * layer limits how many classes one workspace may contribute per epoch.
 */
export const epochEpsilon = (classes: number, epsilon: number) => classes * epsilon;

/**
 * The most a coalition of `m` colluding workspaces can shift the released pair
 * (in L1), because each is clipped: m x clip. Used in the poisoning analysis, and the
 * reason the prior is also capped in weight (posterior.ts).
 */
export const maxPoisonShift = (m: number, clip: number) => m * clip;

/** Exact pmf of the two-sided geometric, for tests and for the privacy analysis. */
export const geometricPmf = (z: number, epsilon: number, sensitivity: number): number => {
  const alpha = Math.exp(-epsilon / sensitivity);
  return ((1 - alpha) / (1 + alpha)) * alpha ** Math.abs(z);
};
