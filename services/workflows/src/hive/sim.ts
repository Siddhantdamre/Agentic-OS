/**
 * Simulation of hive trust: does it help, is it safe, and what does it cost in privacy?
 *
 * WHAT THIS IS, AND IS NOT
 * A controlled experiment on a MODEL of workspaces, not evidence about real
 * customers. Its conclusions hold to exactly the extent that the model's
 * assumptions do, and the assumptions are stated where they are made. It exists
 * to answer, before any customer data flows, whether the mechanism can do what
 * it claims, and to find the settings under which it cannot. Every experiment is
 * deterministic in its seed, so a number quoted anywhere is reproducible.
 *
 * DESIGN
 *  - Paired comparison. Every arm sees the SAME stream of human reviews, so a
 *    difference between arms is the rule, not luck.
 *  - Three arms: the current streak rule (S), the posterior without the hive
 *    (L), and the posterior with it (H).
 *  - "Unsafe graduation": the class graduated while the workspace's true
 *    approval rate was below tau (0.9). "Harm": 1 - true rate at the moment of
 *    graduation, i.e. the share of future automatic actions its own people would
 *    have rejected.
 *  - Workspaces are exchangeable draws from a class-specific population, but
 *    NOT identical: the spread between workspaces is the reason a prior can be
 *    wrong for a given workspace, and it is a parameter.
 */
import { fromDecimal } from './rational';
import { decide, evaluate, DEFAULT_POLICY, TrustPolicy, streakRule, LocalEvidence } from './posterior';
import { makeRelease, Release, Contribution, geometricPmf, isReleased } from './privacy';

// ── Deterministic randomness ─────────────────────────────────────────────

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    const u = Math.max(this.next(), 1e-12), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.next(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  beta(a: number, b: number): number { const x = this.gamma(a), y = this.gamma(b); return x / (x + y); }
  binomial(n: number, p: number): number { let k = 0; for (let i = 0; i < n; i++) if (this.next() < p) k++; return k; }
}

// ── The worlds ───────────────────────────────────────────────────────────

/** The population of true approval rates for one class of action, as (mean, concentration). */
export const CLASSES = {
  safe:  { mean: 0.97, conc: 60, note: 'nearly every workspace approves nearly everything' },
  mixed: { mean: 0.85, conc: 8,  note: 'most approve, some rarely do — the hard case' },
  risky: { mean: 0.60, conc: 8,  note: 'most workspaces reject a lot of these' },
} as const;
export type ClassName = keyof typeof CLASSES;

export interface PopSpec { mean: number; conc: number }
const drawRate = (r: Rng, c: PopSpec) => r.beta(c.mean * c.conc, (1 - c.mean) * c.conc);

export interface CohortParams {
  n: number;            // workspaces in the hive
  optIn: number;        // fraction that share
  history: number;      // decisions each contributing workspace has made
  k: number; clip: number; epsilon: number;
}
export const DEFAULT_COHORT: CohortParams = { n: 100, optIn: 0.5, history: 30, k: 5, clip: 10, epsilon: 2 };

export function drawCohort(r: Rng, cls: ClassName | PopSpec, p: CohortParams): Contribution[] {
  const spec: PopSpec = typeof cls === 'string' ? CLASSES[cls] : cls;
  const out: Contribution[] = [];
  for (let i = 0; i < p.n; i++) {
    const rate = drawRate(r, spec);
    const a = r.binomial(p.history, rate);
    out.push({ orgId: `o${i}`, optedIn: r.next() < p.optIn, approvals: a, rejections: p.history - a });
  }
  return out;
}

const KEY = 'simulation-key';
export const releaseFor = (c: Contribution[], p: CohortParams, label: string): Release =>
  makeRelease(c, { k: p.k, clip: p.clip, epsilon: p.epsilon, key: KEY, label });

// ── One new workspace, three rules, one stream ───────────────────────────

export interface TrialResult {
  /** Reviews until each arm graduated the class, or null within the horizon. */
  S: number | null; L: number | null; H: number | null;
  trueRate: number;
  /** Did the hive veto at any point (arm H)? */
  vetoed: boolean;
}

export function trial(r: Rng, trueRate: number, release: Release | null, policy: TrustPolicy, horizon: number): TrialResult {
  let approvals = 0, rejections = 0, streak = 0;
  const out: TrialResult = { S: null, L: null, H: null, trueRate, vetoed: false };
  for (let t = 1; t <= horizon; t++) {
    if (r.next() < trueRate) { approvals++; streak++; } else { rejections++; streak = 0; }
    const local: LocalEvidence = { approvals, rejections, lockedOut: rejections > 0 };
    if (out.S === null && streakRule(streak)) out.S = t;
    if (out.L === null && evaluate({ graduatable: true, local, hive: { optedIn: true, release: null }, policy }).verdict === 'graduate') out.L = t;
    if (out.H === null) {
      const d = evaluate({ graduatable: true, local, hive: { optedIn: true, release }, policy });
      if (d.veto.triggered) out.vetoed = true;
      if (d.verdict === 'graduate') out.H = t;
    }
    if (out.S !== null && out.L !== null && out.H !== null) break;
  }
  return out;
}

export interface ArmStats {
  graduated: number;        // share that graduated within the horizon
  unsafe: number;           // share of ALL trials that graduated with trueRate < tau
  unsafeGivenGrad: number;  // share of graduates that were unsafe
  harm: number;             // mean (1 - trueRate) over graduates
  medianReviews: number | null;
  meanReviews: number | null;
}

function stats(rows: TrialResult[], arm: 'S' | 'L' | 'H', tau: number): ArmStats {
  const grads = rows.filter((x) => x[arm] !== null);
  const rev = grads.map((x) => x[arm] as number).sort((a, b) => a - b);
  const unsafe = grads.filter((x) => x.trueRate < tau).length;
  return {
    graduated: grads.length / rows.length,
    unsafe: unsafe / rows.length,
    unsafeGivenGrad: grads.length ? unsafe / grads.length : 0,
    harm: grads.length ? grads.reduce((s, x) => s + (1 - x.trueRate), 0) / grads.length : 0,
    medianReviews: rev.length ? rev[Math.floor(rev.length / 2)] : null,
    meanReviews: rev.length ? rev.reduce((s, x) => s + x, 0) / rev.length : null,
  };
}

export interface E1Row { cls: ClassName; S: ArmStats; L: ArmStats; H: ArmStats; vetoRate: number }

/** E1: speed and safety of the three rules, per class. */
export function experimentSpeedSafety(seed: number, trials: number, cohort: CohortParams = DEFAULT_COHORT, policy: TrustPolicy = DEFAULT_POLICY, horizon = 150): E1Row[] {
  const rows: E1Row[] = [];
  for (const cls of Object.keys(CLASSES) as ClassName[]) {
    const r = new Rng(seed ^ hash(cls));
    const all: TrialResult[] = [];
    let release: Release | null = null;
    for (let i = 0; i < trials; i++) {
      if (i % 25 === 0) release = releaseFor(drawCohort(r, cls, cohort), cohort, `e1|${cls}|${i}`);
      all.push(trial(r, drawRate(r, CLASSES[cls]), release, policy, horizon));
    }
    const tau = Number(policy.tau.n) / Number(policy.tau.d);
    rows.push({ cls, S: stats(all, 'S', tau), L: stats(all, 'L', tau), H: stats(all, 'H', tau), vetoRate: all.filter((x) => x.vetoed).length / all.length });
  }
  return rows;
}

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

export interface E2Row { delta: string; L: ArmStats; H: ArmStats }

/** E2: the Pareto sweep. At a fixed safety level, how many reviews does the hive save? */
export function experimentPareto(seed: number, trials: number, cls: ClassName = 'mixed', deltas = ['0.5', '0.35', '0.2', '0.1', '0.05', '0.02'], cohort: CohortParams = DEFAULT_COHORT): E2Row[] {
  const rows: E2Row[] = [];
  for (const d of deltas) {
    const policy: TrustPolicy = { ...DEFAULT_POLICY, delta: fromDecimal(d) };
    const r = new Rng(seed ^ hash('pareto' + d));
    const all: TrialResult[] = [];
    let release: Release | null = null;
    for (let i = 0; i < trials; i++) {
      if (i % 25 === 0) release = releaseFor(drawCohort(r, cls, cohort), cohort, `e2|${d}|${i}`);
      all.push(trial(r, drawRate(r, CLASSES[cls]), release, policy, 200));
    }
    rows.push({ delta: d, L: stats(all, 'L', 0.9), H: stats(all, 'H', 0.9) });
  }
  return rows;
}

// ── Privacy vs utility ───────────────────────────────────────────────────

export interface E3Row { n: number; epsilon: number; suppressed: number; medianRateError: number; decisionAgreement: number; unsafeFlips: number; conservativeFlips: number }

/**
 * E3: what noise costs in usefulness, as the hive grows.
 * rate error = |released approval rate - the cohort's true mean rate|.
 * decision agreement = how often a hive-assisted decision using the NOISY release
 * equals the decision using the exact, noise-free aggregate.
 */
export function experimentUtility(seed: number, reps: number, ns = [10, 30, 100, 300, 1000], epsilons = [0.5, 1, 2, 4], cls: ClassName = 'safe'): E3Row[] {
  const rows: E3Row[] = [];
  for (const n of ns) for (const epsilon of epsilons) {
    const cohort: CohortParams = { ...DEFAULT_COHORT, n, epsilon };
    const r = new Rng(seed ^ hash(`u${n}|${epsilon}`));
    let supp = 0; const errs: number[] = []; let agree = 0, agreeN = 0, unsafeF = 0, consF = 0;
    for (let i = 0; i < reps; i++) {
      const data = drawCohort(r, cls, cohort);
      const noisy = releaseFor(data, cohort, `e3|${n}|${epsilon}|${i}`);
      if (!isReleased(noisy)) { supp++; continue; }
      const exact = makeRelease(data, { k: cohort.k, clip: cohort.clip, epsilon: 1e12, key: KEY, label: `exact|${i}` });
      errs.push(Math.abs(noisy.approvals / Math.max(1, noisy.approvals + noisy.rejections) - CLASSES[cls].mean));
      for (const a of [3, 4, 6]) {
        const local: LocalEvidence = { approvals: a, rejections: 0, lockedOut: false };
        const dn = evaluate({ graduatable: true, local, hive: { optedIn: true, release: noisy } }).verdict;
        const de = evaluate({ graduatable: true, local, hive: { optedIn: true, release: exact } }).verdict;
        agreeN++; if (dn === de) agree++; else if (dn === 'graduate') unsafeF++; else consF++;
      }
    }
    errs.sort((a, b) => a - b);
    rows.push({ n, epsilon, suppressed: supp / reps, medianRateError: errs.length ? errs[Math.floor(errs.length / 2)] : NaN, decisionAgreement: agreeN ? agree / agreeN : NaN, unsafeFlips: agreeN ? unsafeF / agreeN : NaN, conservativeFlips: agreeN ? consF / agreeN : NaN });
  }
  return rows;
}

export interface E4Row { epsilon: number; bound: number; accuracy1: number; accuracyT: number; T: number }

/**
 * E4: can an adversary tell whether one workspace contributed?
 * The strongest realistic adversary: knows every other workspace's exact data
 * and the mechanism, sees the released pair for each of `T` independent epochs,
 * and applies the optimal (likelihood-ratio) test between "target contributed
 * `clip` approvals" and "did not". Accuracy 0.5 is chance. For epsilon-DP a
 * single release cannot exceed e^eps / (1 + e^eps); repeated releases compose,
 * which is why the budget is accounted per epoch.
 */
export function experimentMembership(seed: number, reps: number, epsilons = [0.5, 1, 2, 4], T = 10, clip = 10): E4Row[] {
  const rows: E4Row[] = [];
  for (const epsilon of epsilons) {
    const r = new Rng(seed ^ hash('mi' + epsilon));
    const others: Contribution[] = Array.from({ length: 60 }, (_, i) => ({ orgId: `p${i}`, optedIn: true, approvals: 8, rejections: 2 }));
    const withTarget = [...others, { orgId: 'target', optedIn: true, approvals: clip, rejections: 0 }];
    const base = { k: 5, clip, epsilon, key: KEY };
    let ok1 = 0, okT = 0;
    for (let i = 0; i < reps; i++) {
      const truthIn = r.next() < 0.5;
      const data = truthIn ? withTarget : others;
      let llrT = 0;
      for (let t = 0; t < T; t++) {
        const rel = makeRelease(data, { ...base, label: `mi|${epsilon}|${i}|${t}` });
        if (!isReleased(rel)) continue;
        // Adversary's exact expectations under each hypothesis (clipping is deterministic here: totals are <= clip).
        const ea1 = 60 * 8 + clip, ea0 = 60 * 8, er = 60 * 2;
        const lp = (obs: number, exp: number) => Math.log(geometricPmf(obs - exp, epsilon, clip));
        const llr = lp(rel.approvals, ea1) - lp(rel.approvals, ea0) + lp(rel.rejections, er) - lp(rel.rejections, er);
        llrT += llr;
        if (t === 0) { if ((llr > 0) === truthIn) ok1++; }
      }
      if ((llrT > 0) === truthIn) okT++;
    }
    rows.push({ epsilon, bound: Math.exp(epsilon) / (1 + Math.exp(epsilon)), accuracy1: ok1 / reps, accuracyT: okT / reps, T });
  }
  return rows;
}

// ── Poisoning ────────────────────────────────────────────────────────────

export interface E5Row { colluders: number; H_unsafe: number; L_unsafe: number; safeClassNotGraduated: number; safeMedianH: number | null; safeMedianL: number | null }

/**
 * E5: what can a coalition of workspaces do?
 *  - Push a RISKY class toward graduation for a new workspace by contributing
 *    only approvals. Measured as the new workspace's unsafe-graduation rate.
 *  - Slow a SAFE class by contributing only rejections (the first design, an
 *    outright veto, let 20 colluders freeze it completely). Measured as the
 *    share that fail to graduate within the horizon, and the median reviews for
 *    those that do — compared with the no-hive rule, which the attack can never
 *    do worse than.
 */
export function experimentPoisoning(seed: number, trials: number, ms = [0, 5, 20, 50, 100, 300, 1000, 3000], cohort: CohortParams = DEFAULT_COHORT): E5Row[] {
  const rows: E5Row[] = [];
  for (const m of ms) {
    const r = new Rng(seed ^ hash('poison' + m));
    const attack = (kind: 'approve' | 'reject'): Contribution[] =>
      Array.from({ length: m }, (_, i) => ({ orgId: `evil${i}`, optedIn: true, approvals: kind === 'approve' ? 1e6 : 0, rejections: kind === 'reject' ? 1e6 : 0 }));
    const allRisky: TrialResult[] = [], allSafe: TrialResult[] = [];
    let rr: Release | null = null, rs: Release | null = null;
    for (let i = 0; i < trials; i++) {
      if (i % 25 === 0) {
        rr = releaseFor([...drawCohort(r, 'risky', cohort), ...attack('approve')], cohort, `e5r|${m}|${i}`);
        rs = releaseFor([...drawCohort(r, 'safe', cohort), ...attack('reject')], cohort, `e5s|${m}|${i}`);
      }
      allRisky.push(trial(r, drawRate(r, CLASSES.risky), rr, DEFAULT_POLICY, 150));
      allSafe.push(trial(r, drawRate(r, CLASSES.safe), rs, DEFAULT_POLICY, 150));
    }
    rows.push({
      colluders: m,
      H_unsafe: stats(allRisky, 'H', 0.9).unsafe,
      L_unsafe: stats(allRisky, 'L', 0.9).unsafe,
      safeClassNotGraduated: 1 - stats(allSafe, 'H', 0.9).graduated,
      safeMedianH: stats(allSafe, 'H', 0.9).medianReviews,
      safeMedianL: stats(allSafe, 'L', 0.9).medianReviews,
    });
  }
  return rows;
}

// ── Where does the hive stop helping? ────────────────────────────────────

export interface E6Row { conc: number; L: ArmStats; H: ArmStats }

/**
 * E6: the boundary. Same cohort mean (0.95), increasing spread BETWEEN
 * workspaces (lower concentration = more different from one another). A prior
 * from other workspaces is informative only to the extent that workspaces
 * resemble each other; this finds how much resemblance it takes.
 */
export function experimentHeterogeneity(seed: number, trials: number, concs = [4, 8, 20, 60, 200], cohort: CohortParams = DEFAULT_COHORT): E6Row[] {
  const rows: E6Row[] = [];
  for (const conc of concs) {
    const spec: PopSpec = { mean: 0.95, conc };
    const r = new Rng(seed ^ hash('het' + conc));
    const all: TrialResult[] = [];
    let release: Release | null = null;
    for (let i = 0; i < trials; i++) {
      if (i % 25 === 0) release = releaseFor(drawCohort(r, spec, cohort), cohort, `e6|${conc}|${i}`);
      all.push(trial(r, drawRate(r, spec), release, DEFAULT_POLICY, 150));
    }
    rows.push({ conc, L: stats(all, 'L', 0.9), H: stats(all, 'H', 0.9) });
  }
  return rows;
}

// ── Choosing the parameters against the worst case, not the average ──────

export interface E7Row {
  weight: number; floor: number;
  /** Honest hive, safe class: mean reviews to graduate (the benefit). */
  safeMeanReviews: number | null;
  /** The same safe stream with no hive at all: what the benefit is measured against. */
  safeMeanReviewsNoHive: number | null;
  /** Honest hive, mixed class: unsafe graduations. */
  mixedUnsafe: number;
  /** Fully poisoned prior (approve-only coalition far larger than the hive), risky class: unsafe graduations. */
  poisonedUnsafe: number;
  /** The no-hive rule on the same risky stream, for reference. */
  noHiveUnsafe: number;
}

/**
 * E7: the prior's weight cap and the local floor decide how much a poisoned
 * prior can do, and how much an honest one helps. This sweeps both and reports
 * benefit and worst-case cost side by side, so the defaults are a choice made
 * against evidence rather than a number that looked round.
 */
export function experimentRobustness(seed: number, trials: number, weights = [4, 8, 12], floors = [3, 5, 8], cohort: CohortParams = DEFAULT_COHORT): E7Row[] {
  const rows: E7Row[] = [];
  for (const weight of weights) for (const floor of floors) {
    const policy: TrustPolicy = { ...DEFAULT_POLICY, maxPriorWeight: weight, minLocalApprovals: floor };
    const r = new Rng(seed ^ hash(`rob${weight}|${floor}`));
    const safe: TrialResult[] = [], mixed: TrialResult[] = [], pois: TrialResult[] = [];
    let rs: Release | null = null, rm: Release | null = null, rp: Release | null = null;
    const attackers: Contribution[] = Array.from({ length: 3000 }, (_, i) => ({ orgId: `evil${i}`, optedIn: true, approvals: 1e6, rejections: 0 }));
    for (let i = 0; i < trials; i++) {
      if (i % 25 === 0) {
        rs = releaseFor(drawCohort(r, 'safe', cohort), cohort, `e7s|${weight}|${floor}|${i}`);
        rm = releaseFor(drawCohort(r, 'mixed', cohort), cohort, `e7m|${weight}|${floor}|${i}`);
        rp = releaseFor([...drawCohort(r, 'risky', cohort), ...attackers], cohort, `e7p|${weight}|${floor}|${i}`);
      }
      safe.push(trial(r, drawRate(r, CLASSES.safe), rs, policy, 150));
      mixed.push(trial(r, drawRate(r, CLASSES.mixed), rm, policy, 150));
      pois.push(trial(r, drawRate(r, CLASSES.risky), rp, policy, 150));
    }
    rows.push({
      weight, floor,
      safeMeanReviews: stats(safe, 'H', 0.9).meanReviews,
      safeMeanReviewsNoHive: stats(safe, 'L', 0.9).meanReviews,
      mixedUnsafe: stats(mixed, 'H', 0.9).unsafe,
      poisonedUnsafe: stats(pois, 'H', 0.9).unsafe,
      noHiveUnsafe: stats(pois, 'L', 0.9).unsafe,
    });
  }
  return rows;
}
