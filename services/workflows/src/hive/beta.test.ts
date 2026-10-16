import test from 'node:test';
import assert from 'node:assert/strict';
import { Q, q, add, sub, mul, div, cmp, eq, fromDecimal, toDecimal, toNumber, toString, pow, ONE, ZERO } from './rational';
import { betaCdf, betaMean, approvalsNeeded, probAtLeast } from './beta';

/**
 * The Beta CDF here is computed by ONE method (a binomial sum). A reference that
 * uses the same method proves nothing, so the primary check is against a second,
 * independent exact route: integrate the density term by term.
 *
 *   F(x) = [ sum_{i=0}^{b-1} C(b-1, i) (-1)^i x^(a+i) / (a+i) ] / B(a, b)
 *   B(a, b) = (a-1)! (b-1)! / (a+b-1)!
 *
 * Both are exact rationals, so agreement is equality, not "within 1e-12".
 */
const fact = (n: number): bigint => { let f = 1n; for (let i = 2n; i <= BigInt(n); i++) f *= i; return f; };
const binom = (n: number, k: number): bigint => fact(n) / (fact(k) * fact(n - k));

function referenceCdf(a: number, b: number, x: Q): Q {
  let sum = ZERO;
  for (let i = 0; i <= b - 1; i++) {
    const term = mul(q(binom(b - 1, i) * (i % 2 === 0 ? 1n : -1n), BigInt(a + i)), pow(x, a + i));
    sum = add(sum, term);
  }
  const B = q(fact(a - 1) * fact(b - 1), fact(a + b - 1));
  return div(sum, B);
}

const XS = ['0.05', '0.1', '0.25', '0.5', '0.75', '0.9', '0.95', '0.99'].map(fromDecimal).concat([q(1, 3), q(2, 7), q(13, 17)]);

test('exact rational basics', () => {
  assert.equal(toString(q(6, 8)), '3/4');
  assert.equal(toString(q(-6, -8)), '3/4');
  assert.equal(toString(q(6, -8)), '-3/4');
  assert.equal(toString(fromDecimal('0.9')), '9/10');
  assert.equal(toString(fromDecimal('0.05')), '1/20');
  assert.equal(toString(add(q(1, 3), q(1, 6))), '1/2');
  assert.equal(toString(sub(ONE, q(1, 3))), '2/3');
  assert.equal(toString(div(q(1, 2), q(1, 4))), '2');
  assert.equal(cmp(q(1, 3), q(2, 6)), 0);
  assert.ok(cmp(q(1, 3), q(1, 2)) < 0);
  assert.throws(() => q(1, 0));
  assert.throws(() => fromDecimal('1e-3'));
  assert.equal(toDecimal(q(1, 3), 4), '0.3333');
  assert.equal(toDecimal(q(2, 3), 4), '0.6667');
  assert.ok(Math.abs(toNumber(q(1, 3)) - 1 / 3) < 1e-15);
});

test('matches an independent exact reference for every a, b in 1..14 at eleven x values', () => {
  let checked = 0;
  for (let a = 1; a <= 14; a++) {
    for (let b = 1; b <= 14; b++) {
      for (const x of XS) {
        const got = betaCdf(a, b, x);
        const want = referenceCdf(a, b, x);
        assert.ok(eq(got, want), `Beta(${a},${b}) at ${toString(x)}: ${toString(got)} != ${toString(want)}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 14 * 14 * XS.length);
});

test('closed forms', () => {
  for (const x of XS) {
    assert.ok(eq(betaCdf(1, 1, x), x), 'uniform');
    assert.ok(eq(betaCdf(2, 1, x), pow(x, 2)));
    assert.ok(eq(betaCdf(5, 1, x), pow(x, 5)));
    assert.ok(eq(betaCdf(1, 3, x), sub(ONE, pow(sub(ONE, x), 3))));
  }
});

test('symmetry: F(a,b,x) = 1 - F(b,a,1-x)', () => {
  for (const [a, b] of [[3, 7], [12, 2], [1, 9], [20, 20]]) {
    for (const x of XS) {
      assert.ok(eq(betaCdf(a, b, x), sub(ONE, betaCdf(b, a, sub(ONE, x)))), `a=${a} b=${b} x=${toString(x)}`);
    }
  }
});

test('boundaries and range', () => {
  assert.ok(eq(betaCdf(4, 9, ZERO), ZERO));
  assert.ok(eq(betaCdf(4, 9, ONE), ONE));
  assert.ok(eq(betaCdf(4, 9, q(-1, 2)), ZERO));
  assert.ok(eq(betaCdf(4, 9, q(3, 2)), ONE));
  for (const x of XS) {
    const v = betaCdf(6, 6, x);
    assert.ok(cmp(v, ZERO) > 0 && cmp(v, ONE) < 0);
  }
});

test('monotonic in the evidence: an approval lowers P(rate < tau), a rejection raises it', () => {
  const tau = fromDecimal('0.9');
  for (let a = 1; a < 40; a++) {
    for (const b of [1, 2, 5]) {
      assert.ok(cmp(betaCdf(a + 1, b, tau), betaCdf(a, b, tau)) < 0, `approval did not help at a=${a} b=${b}`);
      assert.ok(cmp(betaCdf(a, b + 1, tau), betaCdf(a, b, tau)) > 0, `rejection did not hurt at a=${a} b=${b}`);
    }
  }
});

test('monotonic in x', () => {
  const xs = [...XS].sort(cmp);
  let prev = ZERO;
  for (const x of xs) {
    const v = betaCdf(7, 3, x);
    assert.ok(cmp(v, prev) >= 0);
    prev = v;
  }
});

/** A third, floating-point route: numeric integration of the density. Tolerance only, and only as a sanity net. */
function floatCdf(a: number, b: number, x: number, steps = 400000): number {
  const lg = (n: number) => { let s = 0; for (let i = 2; i < n; i++) s += Math.log(i); return s; };
  const logB = lg(a) + lg(b) - lg(a + b);
  const f = (t: number) => (t <= 0 || t >= 1 ? 0 : Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t) - logB));
  const h = x / steps;
  let s = f(0) + f(x);
  for (let i = 1; i < steps; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

test('agrees with a floating-point numerical integration (sanity net, 1e-6)', () => {
  for (const [a, b, xs] of [[3, 2, '0.4'], [10, 1, '0.9'], [25, 3, '0.95'], [8, 8, '0.5'], [2, 30, '0.1']] as const) {
    const exact = toNumber(betaCdf(a, b, fromDecimal(xs)));
    const num = floatCdf(a, b, Number(xs));
    assert.ok(Math.abs(exact - num) < 1e-6, `Beta(${a},${b}) at ${xs}: exact ${exact} vs numeric ${num}`);
  }
});

test('mean, and the cold-start arithmetic used in the docs', () => {
  assert.equal(toString(betaMean(1, 1)), '1/2');
  assert.equal(toString(betaMean(9, 1)), '9/10');
  // From a uniform prior, k clean approvals give F(tau) = tau^(k+1). With tau = 0.9 and delta = 0.35 the
  // answer is 9 approvals, i.e. ten pieces of evidence in the sense of the current "ten in a row" rule.
  assert.equal(approvalsNeeded(1, 1, fromDecimal('0.9'), fromDecimal('0.35')), 9);
  assert.ok(eq(betaCdf(10, 1, fromDecimal('0.9')), pow(fromDecimal('0.9'), 10)));
  // A strong, positive prior of 40 approvals and 2 rejections needs far fewer local approvals.
  const fewer = approvalsNeeded(1 + 40, 1 + 2, fromDecimal('0.9'), fromDecimal('0.35'));
  assert.ok(fewer !== null && fewer < 9, `expected fewer than 9, got ${fewer}`);
});

test('a decision is reproducible: same inputs, same exact value, twice', () => {
  const tau = fromDecimal('0.9');
  const v1 = betaCdf(137, 4, tau);
  const v2 = betaCdf(137, 4, tau);
  assert.equal(toString(v1), toString(v2));
  assert.ok(eq(probAtLeast(137, 4, tau), sub(ONE, v1)));
});

test('large evidence is computed exactly and quickly', () => {
  const t0 = Date.now();
  const v = betaCdf(900, 30, fromDecimal('0.95'));
  assert.ok(cmp(v, ZERO) > 0 && cmp(v, ONE) < 0);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

test('rejects non-integer or non-positive parameters', () => {
  assert.throws(() => betaCdf(0, 1, q(1, 2)), RangeError);
  assert.throws(() => betaCdf(1, 0, q(1, 2)), RangeError);
  assert.throws(() => betaCdf(1.5, 1, q(1, 2)), RangeError);
  assert.throws(() => betaCdf(NaN, 1, q(1, 2)), RangeError);
});
