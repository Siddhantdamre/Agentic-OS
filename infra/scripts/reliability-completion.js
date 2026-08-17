#!/usr/bin/env node
/**
 * RELIABILITY ×N over the FULL task completion suite.
 *
 * Not "did a reply arrive" — the earlier reliability check asked only that, and
 * passed 20/20 while the agent was answering "I don't have your business hours"
 * to everything. This runs the whole completion suite repeatedly and treats
 * ANY of these as a real failure:
 *
 *   - a timeout or silence
 *   - a wrong or missing fact
 *   - a gave-up when the data was seeded
 *   - an output-quality violation
 *   - a security control that stopped working
 *
 * STOPS ON FIRST FAILURE. An intermittent fault that gets rerun until it passes
 * is an intermittent fault you have decided not to understand — and this whole
 * session has shown that the "flaky" runs were real bugs every time (blind
 * retrieval, pricing questions parked as payments, research gagging its own
 * reply). The failing tenant is left in place for diagnosis.
 *
 * Usage: node infra/scripts/reliability-completion.js [runs]
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const RUNS = parseInt(process.argv[2] || process.env.RELIABILITY_RUNS || '20', 10);
const SUITE = path.join(__dirname, 'completion-suite.js');
const STATE_FILE = path.join(__dirname, '.harden-state', 'completion.json');
const OUT_FILE = path.join(__dirname, '.harden-state', 'reliability-completion.json');

/** Per-case tally across runs, so an intermittent case is identifiable. */
const perCase = {};
const runs = [];
let firstFailure = null;

function record(runIndex, state, qualityIssues) {
  const caseRows = state.rows || [];
  const failures = [];

  for (const row of caseRows) {
    const id = row.id;
    perCase[id] = perCase[id] || { pass: 0, fail: 0, verdicts: {} };
    // COMPLETED and REFUSED_OK are the only acceptable verdicts. PARTIAL,
    // GAVE_UP and FAIL are all real product failures.
    const good = row.verdict === 'COMPLETED' || row.verdict === 'REFUSED_OK';
    perCase[id][good ? 'pass' : 'fail']++;
    perCase[id].verdicts[row.verdict] = (perCase[id].verdicts[row.verdict] || 0) + 1;
    if (!good) failures.push(`${id}: ${row.verdict} — ${row.why || 'no detail'}`);
  }
  for (const q of qualityIssues) {
    perCase[q.id] = perCase[q.id] || { pass: 0, fail: 0, verdicts: {} };
    failures.push(`${q.id}: QUALITY — ${q.hits.join(', ')}`);
  }

  runs.push({ run: runIndex, failures, rate: state.rate, ok: failures.length === 0 });
  return failures;
}

(function main() {
  console.log(`\n### RELIABILITY ×${RUNS} — full task completion suite`);
  console.log('### any timeout, wrong answer, gave-up or quality miss is a real failure');
  console.log('### stops on first failure for diagnosis\n');

  let scoreQuality;
  try {
    ({ scoreQuality } = require('./quality-rules.js'));
  } catch {
    scoreQuality = () => [];
  }

  for (let i = 1; i <= RUNS; i++) {
    const started = new Date().toISOString().slice(11, 19);
    const res = spawnSync(process.execPath, [SUITE], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 45 * 60 * 1000,
    });

    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.log(`  run ${String(i).padStart(2)}/${RUNS}  [${started}]  ABORTED — no state written (${e.message})`);
      firstFailure = { run: i, failures: ['suite produced no state file'], stdout: (res.stdout || '').slice(-3000) };
      break;
    }

    const qualityIssues = (state.rows || [])
      .filter((r) => r.reply && r.reply.trim())
      .map((r) => ({ id: r.id, hits: scoreQuality(r.reply).map((h) => h.name) }))
      .filter((q) => q.hits.length > 0);

    const failures = record(i, state, qualityIssues);
    const label = failures.length ? 'FAIL' : 'ok  ';
    console.log(
      `  run ${String(i).padStart(2)}/${RUNS}  [${started}]  ${label}  completion ${state.rate}%  quality ${
        (state.rows || []).filter((r) => r.reply && r.reply.trim()).length - qualityIssues.length
      } clean`
    );

    if (failures.length) {
      for (const f of failures) console.log(`        ${f}`);
      firstFailure = { run: i, failures, stdout: (res.stdout || '').slice(-4000) };
      console.log('\n  STOPPING for diagnosis — not rerunning blindly.');
      break;
    }
  }

  const completed = runs.length;
  const passed = runs.filter((r) => r.ok).length;

  console.log('\n  ===== PER-CASE TALLY =====');
  console.log('  case                pass  fail  verdicts');
  for (const [id, t] of Object.entries(perCase)) {
    const v = Object.entries(t.verdicts).map(([k, n]) => `${k}×${n}`).join(' ');
    console.log(`  ${id.padEnd(19)} ${String(t.pass).padEnd(5)} ${String(t.fail).padEnd(5)} ${v}`);
  }

  console.log('\n  ===== RELIABILITY =====');
  console.log(`  runs completed   ${completed}/${RUNS}`);
  console.log(`  runs fully clean ${passed}/${completed}`);
  if (firstFailure) {
    console.log(`  FIRST FAILURE at run ${firstFailure.run}:`);
    for (const f of firstFailure.failures) console.log(`    ${f}`);
  } else if (completed === RUNS) {
    console.log('  ALL RUNS CLEAN');
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ runs: RUNS, completed, passed, perCase, firstFailure }, null, 2));
  console.log(`\n  state: ${OUT_FILE}`);
  process.exit(firstFailure ? 1 : 0);
})();
