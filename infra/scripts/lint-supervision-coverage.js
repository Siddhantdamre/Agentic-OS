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

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
