/**
 * The Beta distribution with INTEGER parameters, in exact arithmetic.
 *
 * For X ~ Beta(a, b) with integers a, b >= 1, the CDF is a finite sum:
 *
 *     P(X <= x) = P( Binomial(a + b - 1, x) >= a )
 *               = sum_{j=a}^{n}  C(n, j) x^j (1 - x)^(n - j),   n = a + b - 1
 *
 * With x = p / q_ rational, every term has denominator q_^n, so the whole sum is
 * one exact BigInt fraction. No gamma functions, no continued fractions, no
 * floating point: the value returned is THE value, not an approximation of it.
 *
 * WHY THE PARAMETERS ARE INTEGERS
 * A Beta prior over an approval rate is (1 + approvals, 1 + rejections). Counts
 * are integers, and everything that feeds the prior (the hive's released
 * aggregate, after noise and rounding) is made an integer before it gets here.
 * That is a design constraint, not a limitation: it is what makes a decision
 * exactly reproducible.
 */
import { Q, ONE, ZERO, add, mul, q, sub, lte, gte, pow } from './rational';

function assertPosInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} must be an integer >= 1, got ${v}`);
}

/**
 * The function is pure, so results are memoised. A workspace's decision is
 * evaluated after every approval and the same (a, b, tau) recurs constantly;
 * exactness is unaffected because the cached value IS the exact value.
 */
const memo = new Map<string, Q>();
const MEMO_CAP = 200_000;

/** P(X <= x) for X ~ Beta(a, b). Exact. */
export function betaCdf(a: number, b: number, x: Q): Q {
  assertPosInt('a', a);
  assertPosInt('b', b);
  const key = `${a}|${b}|${x.n}/${x.d}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const v = betaCdfUncached(a, b, x);
  if (memo.size >= MEMO_CAP) memo.clear();
  memo.set(key, v);
  return v;
}

function betaCdfUncached(a: number, b: number, x: Q): Q {
  if (x.n <= 0n) return ZERO;
  if (x.n >= x.d) return ONE;

  const n = a + b - 1;
  const p = x.n;
  const qm = x.d - x.n; // (1 - x) * denominator
  const den = x.d;

  // pp[j] = p^j, rr[k] = (den - p)^k, built once.
  const pp: bigint[] = new Array(n + 1);
  const rr: bigint[] = new Array(n + 1);
  pp[0] = 1n;
  rr[0] = 1n;
  for (let i = 1; i <= n; i++) {
    pp[i] = pp[i - 1] * p;
    rr[i] = rr[i - 1] * qm;
  }

  // C(n, j) built incrementally from C(n, a): the integer division is exact.
  let binom = 1n;
  for (let i = 1; i <= a; i++) binom = (binom * BigInt(n - a + i)) / BigInt(i); // C(n, a)
  let num = 0n;
  for (let j = a; j <= n; j++) {
    num += binom * pp[j] * rr[n - j];
    binom = (binom * BigInt(n - j)) / BigInt(j + 1); // C(n, j+1)
  }
  return q(num, den ** BigInt(n));
}

/** E[X] = a / (a + b). */
export function betaMean(a: number, b: number): Q {
  assertPosInt('a', a);
  assertPosInt('b', b);
  return q(a, a + b);
}

/**
 * Posterior probability that the approval rate is BELOW `tau`, i.e. P(p < tau).
 * (The CDF is continuous, so < and <= coincide.) This is the quantity every
 * graduation and veto decision is a threshold on.
 */
export function probBelow(a: number, b: number, tau: Q): Q {
  return betaCdf(a, b, tau);
}

/** P(p >= tau) = 1 - CDF(tau). */
export function probAtLeast(a: number, b: number, tau: Q): Q {
  return sub(ONE, betaCdf(a, b, tau));
}

/**
 * The smallest number of clean approvals (zero rejections) after which
 * Beta(a0 + k, b0) puts at least 1 - delta of its mass at or above tau.
 * A closed-form-free search, exact at every step; used to state, in the receipt
 * and in the docs, "this many approvals from a cold start".
 */
export function approvalsNeeded(a0: number, b0: number, tau: Q, delta: Q, cap = 5000): number | null {
  for (let k = 0; k <= cap; k++) {
    if (lte(betaCdf(a0 + k, b0, tau), delta)) return k;
  }
  return null;
}

export { add, mul, gte, lte, pow };
