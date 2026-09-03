#!/usr/bin/env node
'use strict';
/**
 * EVERY EXIT IS SUPERVISED — enforced structurally, not remembered.
 *
 * Supervision was recorded at a single point near the end of WorkItemWorkflow.
 * There were TEN returns before it: six failures, two cancellations, one
 * escalation to a human, and one success. None of them recorded anything, so
 * the trio reported only on tasks that ran cleanly to the end — the population
 * that needs the least supervising.
 *
 * The runtime check (check-supervision.js) catches this empirically, but only
 * once traffic exists. On a deployment with no traffic it passes while the hole
 * is wide open, which is exactly the state this codebase was in.
 *
 * So the shape is checked directly:
 *
 *   1. recordTaskSupervisionActivity is called EXACTLY ONCE in the file
 *   2. that call is inside reportTrio, not the workflow body
 *   3. the exported workflow returns only the wrapped result — every other
 *      `return` lives inside runWorkItem, which the wrapper always supervises
 *
 * Add an eleventh early return tomorrow and it is covered automatically. Move
 * the recording back inline, or return directly from the wrapper around the
 * try/catch, and this fails.
 *
 * Usage: node infra/scripts/lint-supervision-coverage.js
 * Exit:  0 = every exit is supervised, 1 = a path can finish unsupervised
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(
  __dirname, '..', '..', 'services', 'workflows', 'src', 'workflows', 'WorkItemWorkflow.ts');

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n=== SUPERVISION COVERAGE — can any path finish unreported? ===\n');

const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

/** Line index where a top-level `function`/`async function` NAME begins. */
function fnStart(name) {
  return lines.findIndex((l) =>
    new RegExp(`^(export )?async function ${name}\\b`).test(l));
}

const iWrapper = fnStart('WorkItemWorkflow');
const iReport = fnStart('reportTrio');
const iBody = fnStart('runWorkItem');

[['WorkItemWorkflow', iWrapper], ['reportTrio', iReport], ['runWorkItem', iBody]]
  .forEach(([n, i]) => {
    if (i < 0) no(`${n}() exists`, 'the wrapper structure was removed or renamed');
  });

if (iWrapper >= 0 && iReport >= 0 && iBody >= 0) {
  ok('the wrapper, the recorder and the body all exist');

  // ── 1. Exactly one recording call ─────────────────────────────────────────
  const calls = [];
  lines.forEach((l, i) => {
    if (/recordTaskSupervisionActivity\s*\(/.test(l)) calls.push(i + 1);
  });
  calls.length === 1
    ? ok('recordTaskSupervisionActivity is called exactly once', `line ${calls[0]}`)
    : no('recordTaskSupervisionActivity is called exactly once',
      calls.length === 0
        ? 'not called at all — nothing is supervised'
        : `called ${calls.length} times (lines ${calls.join(', ')}); two recorders drift, `
          + 'and only one of them gets maintained');

  // ── 2. It lives in the recorder, not the body ─────────────────────────────
  if (calls.length === 1) {
    const at = calls[0] - 1;
    at > iReport && at < iBody
      ? ok('the recording is inside reportTrio()', 'no return in the body can skip it')
      : no('the recording is inside reportTrio()',
        'it is back in the workflow body, where an early return skips it — '
        + 'that is the exact defect this lint exists to prevent');
  }

  // ── 3. The wrapper itself has one exit ────────────────────────────────────
  // Everything between the wrapper and reportTrio is the wrapper's body. It
  // must return the wrapped result and nothing else; a bare `return` added
  // above the try/catch would bypass supervision entirely.
  const wrapperBody = lines.slice(iWrapper, iReport);
  const returns = wrapperBody.filter((l) => /^\s*return\b/.test(l));
  returns.length === 1 && /return result;/.test(returns[0])
    ? ok('the wrapper has exactly one exit, and it is the supervised one')
    : no('the wrapper has exactly one exit',
      `found ${returns.length}: ${returns.map((r) => r.trim()).join(' | ')}`);

  const rethrows = wrapperBody.filter((l) => /^\s*throw\b/.test(l));
  rethrows.length >= 1
    ? ok('a thrown task is reported and then rethrown',
      'a crash is when supervision matters most')
    : no('a thrown task is reported and then rethrown',
      'the catch branch no longer rethrows — a failure would be swallowed');

  // ── 4. Every other exit is inside the supervised body ─────────────────────
  const bodyReturns = lines.slice(iBody).filter((l) => /^\s*return\s*\{/.test(l)).length;
  bodyReturns > 0
    ? ok(`all ${bodyReturns} work-item exits sit inside runWorkItem()`,
      'each one is wrapped, including any added later')
    : no('the body has returns to supervise', 'structure changed — re-read this file');
}

// ── 5. Every OTHER workflow has stated its position ────────────────────────
//
// The four checks above prove that every exit of WorkItemWorkflow is
// supervised. That is all they prove — and the header above them claimed
// "EVERY EXIT IS SUPERVISED" while reading exactly one file.
//
// There are sixteen workflows. One records supervision. Among the other fifteen
// is AutonomousAgentWorkflow, which is what every standing duty and every
// inbound customer reply actually runs through. Measured on this database:
// 807 rows in agent_actions, ONE row in task_supervision.
//
// Some of those fifteen genuinely should not report the trio — an embedding job
// is not agent work and has no doer to monitor. The defect was never that they
// are unsupervised. It is that nothing recorded WHICH they were, so a
// deliberate exclusion and an oversight were indistinguishable from outside.
//
// So: the same bargain lint-check-coverage.js already makes for checkers.
// Staying outside requires stating your case in writing.
//
//   SUPERVISION: not-agent-work — <why>   excused
//   SUPERVISION: GAP — <why>              a known hole, counted and printed
//
// A workflow with neither a recording call nor a marker FAILS, because the
// silent case is the actual defect. A declared GAP does not fail the build —
// failing today would only get the marker downgraded to the weaker one — but it
// is printed on every run, with a count, so it cannot quietly become normal.
const WF_DIR = path.join(__dirname, '..', '..', 'services', 'workflows', 'src', 'workflows');
const workflowFiles = fs.readdirSync(WF_DIR)
  .filter((f) => /Workflow\.ts$/.test(f) && !/\.test\./.test(f))
  .sort();

const gaps = [];
const excused = [];
const silent = [];
let supervised = 0;

for (const f of workflowFiles) {
  const body = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
  if (/recordTaskSupervisionActivity\s*\(/.test(body)) { supervised += 1; continue; }
  // Matches to the end of the comment block, not the end of the line. A wrapped
  // reason read one line deep, so "THE LARGEST ONE. Every standing duty and
  // every inbound" was all anyone saw of the largest gap in the system.
  const marker = /SUPERVISION:\s*(GAP|not-agent-work)\s*—\s*([\s\S]*?)\*\//.exec(body);
  const reason = marker
    ? marker[2].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).join(' ').trim()
    : '';
  const gap = marker && marker[1] === 'GAP' ? [null, reason] : null;
  const exc = marker && marker[1] === 'not-agent-work' ? [null, reason] : null;
  if (gap) gaps.push([f, gap[1].trim()]);
  else if (exc) excused.push([f, exc[1].trim()]);
  else silent.push(f);
}

console.log('');
ok(`${supervised} of ${workflowFiles.length} workflows record the supervision trio`);
if (excused.length) ok(`${excused.length} excused in writing as not agent work`);

if (silent.length) {
  no(`${silent.length} workflow(s) neither supervise nor say why`,
    `${silent.join(', ')} — add a SUPERVISION: marker to the file header`);
} else {
  ok('no workflow is silently unsupervised', 'every one supervises or states its case');
}

if (gaps.length) {
  console.log(`\n  KNOWN GAPS (${gaps.length}) — unsupervised, and we know it:`);
  for (const [f, why] of gaps) console.log(`    ${f}\n      ${why}`);
}

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
