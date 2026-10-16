import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRelease, geometricNoise, geometricPmf, maxPoisonShift, epochEpsilon, clipPair, Contribution, Release } from './privacy';

/** Narrow a release to the un-suppressed shape (this package compiles with strict:false, where the union does not narrow). */
const open = (r: Release) => {
  if (r.suppressed) throw new Error('release was suppressed');
  return r as Extract<Release, { suppressed: false }>;
};

const KEY = 'test-key-not-a-secret';
const orgs = (n: number, a = 10, r = 1, optedIn = true): Contribution[] =>
  Array.from({ length: n }, (_, i) => ({ orgId: `org-${i}`, optedIn, approvals: a, rejections: r }));
const P = { k: 5, clip: 20, epsilon: 1, key: KEY, label: 'send|all|2026-w40' };

test('below k nothing is released, not even a small number', () => {
  const r = makeRelease(orgs(4), P);
  assert.deepEqual(r, { suppressed: true, reason: 'below_k', k: 5 });
  assert.equal(makeRelease(orgs(5), P).suppressed, false);
});

test('workspaces that did not opt in are not counted toward k, and contribute nothing', () => {
  const mixed = [...orgs(4), ...orgs(50, 10, 1, false).map((c, i) => ({ ...c, orgId: `no-${i}` }))];
  assert.equal(makeRelease(mixed, P).suppressed, true, 'fifty non-participants must not lift the threshold');
});

test('the same workspace listed twice counts once toward k', () => {
  const dup = [...orgs(4), { orgId: 'org-0', optedIn: true, approvals: 1, rejections: 0 }];
  assert.equal(makeRelease(dup, P).suppressed, true);
});

test('each workspace is clipped in TOTAL, so no one moves the aggregate by more than clip', () => {
  const base = orgs(5, 10, 1);
  const big = base.map((c, i) => (i === 0 ? { ...c, approvals: 1_000_000, rejections: 1_000_000 } : c));
  // Noise is set to (effectively) zero so the counts are not clamped at 0 and the arithmetic is visible.
  const quiet = { ...P, epsilon: 1e9 };
  const a = open(makeRelease(base, quiet));
  const b = open(makeRelease(big, quiet));
  assert.equal(b.approvals + b.rejections - (a.approvals + a.rejections), P.clip - 11, 'org 0 went from a total of 11 to exactly clip');
});

test('clipping keeps the rate: 29 approvals and 1 rejection do not become a cohort of false alarms', () => {
  // Capping each count separately would turn (29, 1) into (10, 1): 91% instead of 97%.
  let A = 0, R = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const [a, r] = clipPair(29, 1, 10, KEY, 'rate-test', `org-${i}`);
    assert.equal(a + r, 10);
    A += a; R += r;
  }
  const rate = A / (A + R);
  assert.ok(Math.abs(rate - 29 / 30) < 0.006, `rate ${rate.toFixed(4)} vs ${(29 / 30).toFixed(4)}`);
  // ...and a rare rejection survives in expectation rather than being rounded to zero.
  assert.ok(R / N > 0.28 && R / N < 0.38, `mean rejections per org ${(R / N).toFixed(3)}, expected ~0.333`);
});

test('clipping is deterministic for one release and changes with the release', () => {
  assert.deepEqual(clipPair(29, 1, 10, KEY, 'L', 'org-1'), clipPair(29, 1, 10, KEY, 'L', 'org-1'));
  const outs = new Set(Array.from({ length: 200 }, (_, i) => clipPair(29, 1, 10, KEY, `L${i}`, 'org-1').join(',')));
  assert.ok(outs.size >= 2, 'rounding should vary across releases');
  assert.deepEqual(clipPair(3, 4, 10, KEY, 'L', 'x'), [3, 4], 'under the cap nothing changes');
});

test('a release is computed once: asking again cannot average the noise away', () => {
  const first = JSON.stringify(makeRelease(orgs(8), P));
  for (let i = 0; i < 500; i++) assert.equal(JSON.stringify(makeRelease(orgs(8), P)), first);
  assert.notEqual(JSON.stringify(makeRelease(orgs(8), { ...P, label: 'send|all|2026-w41' })), first, 'a new epoch gets new noise');
});

test('released counts are non-negative integers', () => {
  for (let i = 0; i < 300; i++) {
    const r = open(makeRelease(orgs(5, 0, 0), { ...P, label: `x${i}`, epsilon: 0.2 }));
    assert.ok(Number.isInteger(r.approvals) && r.approvals >= 0);
    assert.ok(Number.isInteger(r.rejections) && r.rejections >= 0);
  }
});

test('the noise has the distribution it claims: zero mean, variance 2a/(1-a)^2', () => {
  const eps = 1, sens = 1, n = 60000;
  const alpha = Math.exp(-eps / sens);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const z = geometricNoise(KEY, `n${i}`, eps, sens); s += z; s2 += z * z; }
  const mean = s / n, variance = s2 / n - mean * mean;
  const want = (2 * alpha) / (1 - alpha) ** 2;
  assert.ok(Math.abs(mean) < 0.05, `mean ${mean}`);
  assert.ok(Math.abs(variance / want - 1) < 0.05, `variance ${variance} vs ${want}`);
});

test('DP, analytically: the pmf ratio between outputs one sensitivity apart never exceeds e^epsilon', () => {
  for (const [eps, sens] of [[0.1, 1], [0.5, 5], [1, 20], [2, 20], [0.25, 3]] as const) {
    for (let z = -200; z <= 200; z++) {
      const ratio = geometricPmf(z, eps, sens) / geometricPmf(z - sens, eps, sens);
      assert.ok(ratio <= Math.exp(eps) * (1 + 1e-12) && ratio >= Math.exp(-eps) * (1 - 1e-12), `eps=${eps} sens=${sens} z=${z} ratio=${ratio}`);
    }
  }
});

test('DP, empirically: releases with and without one workspace are statistically close', () => {
  // Neighbouring datasets: the same 7 workspaces, with and without a 8th that contributes `clip`.
  // Each release uses a fresh label (a fresh epoch), so we sample the output distribution.
  const eps = 1; // epsilon-DP for the pair; the marginal on one count is at most eps
  const N = 60000;
  const hist = (extra: boolean) => {
    const h = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      const data = orgs(7, 10, 1);
      if (extra) data.push({ orgId: 'x', optedIn: true, approvals: 20, rejections: 0 });
      const r = open(makeRelease(data, { ...P, k: 5, clip: 20, epsilon: eps, label: `e${i}` }));
      h.set(r.approvals, (h.get(r.approvals) ?? 0) + 1);
    }
    return h;
  };
  const without = hist(false), withX = hist(true);
  let worst = 0, bins = 0;
  for (const [v, c] of without) {
    const c2 = withX.get(v) ?? 0;
    if (c >= 400 && c2 >= 400) { worst = Math.max(worst, Math.abs(Math.log(c / c2))); bins++; }
  }
  assert.ok(bins >= 5, `too few well-populated bins (${bins})`);
  // The guarantee is eps for this count; allow sampling error on top.
  assert.ok(worst <= eps + 0.2, `empirical privacy loss ${worst.toFixed(3)} exceeds ${(eps + 0.2).toFixed(3)}`);
});

test('poisoning is bounded: m colluders shift a released count by at most m x clip', () => {
  const honest = orgs(6, 10, 4);
  for (const m of [1, 3, 10, 40]) {
    const attackers: Contribution[] = Array.from({ length: m }, (_, i) => ({ orgId: `evil-${i}`, optedIn: true, approvals: 1e9, rejections: 0 }));
    const quiet = { ...P, epsilon: 1e9 };
    const clean = open(makeRelease(honest, quiet));
    const dirty = open(makeRelease([...honest, ...attackers], quiet));
    assert.ok(dirty.approvals - clean.approvals <= maxPoisonShift(m, P.clip), `m=${m}`);
    assert.equal(dirty.approvals - clean.approvals, m * P.clip, 'the bound is tight: each colluder contributes exactly clip');
    assert.equal(dirty.rejections, clean.rejections, 'attackers who only approve cannot change the rejection count');
  }
});

test('composition is reported as classes x epsilon', () => {
  assert.equal(epochEpsilon(6, 0.5), 3);
});

test('bad parameters are refused', () => {
  assert.throws(() => makeRelease(orgs(5), { ...P, k: 0 }), RangeError);
  assert.throws(() => makeRelease(orgs(5), { ...P, clip: 0 }), RangeError);
  assert.throws(() => geometricNoise(KEY, 'l', 0, 1), RangeError);
  assert.throws(() => geometricNoise(KEY, 'l', 1, 0), RangeError);
});
