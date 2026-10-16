/**
 * Exact rational arithmetic on BigInt.
 *
 * WHY THIS EXISTS
 * A trust decision — "may this agent now send without asking?" — is a
 * threshold on a probability. If that probability is a float, the answer at the
 * boundary depends on the CPU, the compiler and the summation order, so the same
 * evidence can graduate an agent on one machine and not on another, and nobody
 * can re-derive a decision an auditor questions. With integer Beta parameters
 * every quantity in this module is an exact rational number, so a decision is a
 * pure function of its inputs: reproducible bit for bit, on any machine, years
 * later, from the receipt alone.
 *
 * Values are always stored normalised: d > 0 and gcd(n, d) = 1.
 */
export interface Q {
  readonly n: bigint;
  readonly d: bigint;
}

const abs = (x: bigint) => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new RangeError('rational with zero denominator');
  if (dd < 0n) {
    nn = -nn;
    dd = -dd;
  }
  const g = gcd(nn, dd);
  return g > 1n ? { n: nn / g, d: dd / g } : { n: nn, d: dd };
}

export const ZERO: Q = q(0);
export const ONE: Q = q(1);

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);

export function cmp(a: Q, b: Q): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}
export const eq = (a: Q, b: Q) => cmp(a, b) === 0;
export const lte = (a: Q, b: Q) => cmp(a, b) <= 0;
export const gte = (a: Q, b: Q) => cmp(a, b) >= 0;

/** Exact parse of a plain decimal such as "0.9" or "0.05". No exponents, no floats. */
export function fromDecimal(s: string): Q {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`not a plain decimal: ${JSON.stringify(s)}`);
  const frac = m[3] ?? '';
  const n = BigInt(m[2] + frac) * (m[1] === '-' ? -1n : 1n);
  return q(n, 10n ** BigInt(frac.length));
}

/** Nearest double, for display and for the float cross-checks in tests only. Never used to decide. */
export function toNumber(a: Q): number {
  // Scale so the division keeps ~17 significant digits even for huge n and d.
  const scale = 10n ** 30n;
  return Number((a.n * scale) / a.d) / 1e30;
}

/** "3/8" or "5". Stable, so it can go into a receipt and be compared as text. */
export function toString(a: Q): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}

/** Decimal rendering to `places` places, rounded half away from zero. Display only. */
export function toDecimal(a: Q, places = 6): string {
  const scale = 10n ** BigInt(places);
  const neg = a.n < 0n;
  const num = abs(a.n) * scale;
  let v = num / a.d;
  if ((num % a.d) * 2n >= a.d) v += 1n;
  const s = v.toString().padStart(places + 1, '0');
  const out = places === 0 ? s : `${s.slice(0, -places)}.${s.slice(-places)}`;
  return (neg && v !== 0n ? '-' : '') + out;
}

export function pow(a: Q, e: number): Q {
  if (!Number.isInteger(e) || e < 0) throw new RangeError('non-negative integer exponent required');
  return q(a.n ** BigInt(e), a.d ** BigInt(e));
}
