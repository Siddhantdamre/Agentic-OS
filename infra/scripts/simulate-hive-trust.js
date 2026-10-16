#!/usr/bin/env node
'use strict';
/**
 * HIVE TRUST — SIMULATION REPORT
 *
 * Runs the seven experiments in services/workflows/src/hive/sim.ts with fixed
 * seeds and prints the tables quoted in docs/adr/023-hive-trust.md. Same seed,
 * same numbers, on any machine.
 *
 * These are experiments on a MODEL of workspaces. They show whether the
 * mechanism can do what it claims and where it cannot; they are not evidence
 * about real customers, and the ADR says so.
 *
 * Usage: node infra/scripts/simulate-hive-trust.js [--quick] [--only e1,e2,...] [--trials N] [--json out.json]
 */
const path = require('path');
const fs = require('fs');
const sim = require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'hive', 'sim.js'));

const quick = process.argv.includes('--quick');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const want = (k) => !only || only.includes(k);
const trialsArg = process.argv.includes('--trials') ? parseInt(process.argv[process.argv.indexOf('--trials') + 1], 10) : null;
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const SEED = 20260930;
const N = trialsArg || (quick ? 300 : 1000);
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const num = (x, d = 1) => (x === null || Number.isNaN(x) ? '—' : x.toFixed(d));
const t0 = Date.now();
const out = { seed: SEED, trials: N, quick };

console.log(`\nHIVE TRUST SIMULATION  (seed ${SEED}, ${N} new workspaces per cell${quick ? ', QUICK' : ''})\n`);
const pol = require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'hive', 'posterior.js')).DEFAULT_POLICY;
const co = sim.DEFAULT_COHORT;
const frac = (q) => `${q.n}/${q.d}`;
console.log(`Hive: ${co.n} workspaces, ${co.optIn * 100}% sharing, clip ${co.clip}, epsilon ${co.epsilon}, k ${co.k}.  Policy: tau ${frac(pol.tau)}, delta ${frac(pol.delta)}, local floor ${pol.minLocalApprovals}, prior weight <= ${pol.maxPriorWeight}, caution needs ${pol.cautionMinLocalApprovals} local approvals at delta ${frac(pol.cautionDelta)}.\n`);

if (want('e1')) {
// E1
console.log('E1  SPEED AND SAFETY — the same review stream through three rules');
console.log('    S = today (10 approvals in a row)   L = posterior, no hive   H = posterior + hive prior');
console.log('    reviews = human reviews until the class stops asking (median, among those that graduate)');
console.log('    unsafe  = graduated although the workspace\'s true approval rate is below 90%  (share of ALL new workspaces)\n');
const e1 = sim.experimentSpeedSafety(SEED, N);
out.e1 = e1;
console.log('    class   arm   graduates   median reviews   unsafe graduations   harm*');
for (const row of e1) for (const arm of ['S', 'L', 'H']) {
  const s = row[arm];
  console.log(`    ${row.cls.padEnd(6)}  ${arm}     ${pct(s.graduated).padStart(6)}      ${String(num(s.medianReviews, 0)).padStart(6)}          ${pct(s.unsafe).padStart(6)}         ${pct(s.harm, 2).padStart(6)}`);
}
console.log('    * harm = mean share of future automatic actions its own people would have rejected, among graduates');
console.log('    hive veto fired for:', e1.map((r) => `${r.cls} ${pct(r.vetoRate)}`).join(', '), '\n');

}

if (want('e2')) {
// E2
console.log('E2  PARETO — at matched safety, how many reviews does the hive save?');
out.e2 = {};
for (const cls of ['safe', 'mixed']) {
  const e2 = sim.experimentPareto(SEED, N, cls);
  out.e2[cls] = e2;
  console.log(`    class: ${cls}`);
  console.log('    delta   ---- no hive (L) ----      ---- with hive (H) ----');
  console.log('            unsafe   median reviews    unsafe   median reviews   graduates');
  for (const r of e2) console.log(`    ${r.delta.padEnd(5)}   ${pct(r.L.unsafe).padStart(6)}   ${String(num(r.L.medianReviews, 0)).padStart(8)}          ${pct(r.H.unsafe).padStart(6)}   ${String(num(r.H.medianReviews, 0)).padStart(8)}         ${pct(r.H.graduated).padStart(6)}`);
  console.log();
}

}

if (want('e3')) {
// E3
console.log('E3  PRIVACY vs UTILITY — what the noise costs as the hive grows  (class: safe, 50% sharing)');
const e3 = sim.experimentUtility(SEED, quick ? 60 : 300);
out.e3 = e3;
console.log('    hive size  epsilon   suppressed(<k)   median rate error   decision unchanged   flipped to graduate   flipped to hold');
console.log('                                                                          by noise             (unsafe direction)    (conservative)');
for (const r of e3) console.log(`    ${String(r.n).padStart(8)}   ${String(r.epsilon).padStart(5)}       ${pct(r.suppressed, 0).padStart(6)}          ${pct(r.medianRateError, 2).padStart(7)}             ${pct(r.decisionAgreement, 0).padStart(5)}              ${pct(r.unsafeFlips, 1).padStart(6)}             ${pct(r.conservativeFlips, 1).padStart(6)}`);
console.log();

}

if (want('e4')) {
// E4
console.log('E4  MEMBERSHIP INFERENCE — an adversary who knows everyone else and applies the optimal test');
const e4 = sim.experimentMembership(SEED, quick ? 1500 : 6000);
out.e4 = e4;
console.log('    epsilon   theoretical max (1 release)   observed (1 release)   observed (10 independent epochs)');
for (const r of e4) console.log(`    ${String(r.epsilon).padStart(5)}          ${pct(r.bound).padStart(6)}                   ${pct(r.accuracy1).padStart(6)}                 ${pct(r.accuracyT).padStart(6)}`);
console.log('    (50% = chance. The 10-epoch column is why the budget is accounted per epoch.)\n');

}

if (want('e5')) {
// E5
console.log('E5  POISONING — what a coalition of sharing workspaces can do');
const e5 = sim.experimentPoisoning(SEED, N);
out.e5 = e5;
console.log('    colluders   push a RISKY class through (approve-only):   slow a SAFE class (reject-only):');
console.log('                unsafe grads with hive   without hive     never graduate   median reviews (hive)   (no hive)');
for (const r of e5) console.log(`    ${String(r.colluders).padStart(9)}        ${pct(r.H_unsafe).padStart(6)}               ${pct(r.L_unsafe).padStart(6)}            ${pct(r.safeClassNotGraduated).padStart(6)}            ${String(num(r.safeMedianH, 0)).padStart(6)}              ${String(num(r.safeMedianL, 0)).padStart(6)}`);
}

if (want('e6')) {
// E6
console.log('\nE6  WHERE THE HIVE STOPS HELPING — cohort mean 0.95, increasing difference BETWEEN workspaces');
const e6 = sim.experimentHeterogeneity(SEED, N);
out.e6 = e6;
console.log('    concentration*   no hive (L): mean (median) reviews / unsafe     with hive (H): mean (median) reviews / unsafe');
for (const r of e6) console.log(`    ${String(r.conc).padStart(8)}          ${num(r.L.meanReviews, 1).padStart(5)} (${String(num(r.L.medianReviews, 0)).padStart(3)}) / ${pct(r.L.unsafe).padStart(6)}                  ${num(r.H.meanReviews, 1).padStart(5)} (${String(num(r.H.medianReviews, 0)).padStart(3)}) / ${pct(r.H.unsafe).padStart(6)}`);
console.log('    * low = workspaces differ a lot from one another; high = they behave alike');
}

if (want('e7')) {
// E7
console.log('\nE7  CHOOSING THE PARAMETERS AGAINST THE WORST CASE — prior weight cap x local floor');
console.log('    benefit = mean reviews to graduate a SAFE class with an honest hive');
console.log('    cost    = unsafe graduations on a RISKY class when 3,000 colluders poison the prior with approvals only');
const e7 = sim.experimentRobustness(SEED, N);
out.e7 = e7;
console.log('    weight  floor   safe class: mean reviews (no hive)   honest mixed: unsafe   POISONED: unsafe   (no hive: unsafe)');
for (const r of e7) console.log(`    ${String(r.weight).padStart(6)}  ${String(r.floor).padStart(5)}         ${num(r.safeMeanReviews, 1).padStart(6)}   (${num(r.safeMeanReviewsNoHive, 1).padStart(5)})               ${pct(r.mixedUnsafe).padStart(6)}            ${pct(r.poisonedUnsafe).padStart(6)}           ${pct(r.noHiveUnsafe).padStart(6)}`);
}

console.log(`\ncompleted in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1)); console.log('wrote', jsonOut); }
