#!/usr/bin/env node
'use strict';
/**
 * A CHECK NOTHING RUNS IS NOT A CHECK.
 *
 * Three times in one day a real defect sat behind a checker that existed and
 * was never executed:
 *
 *   CI was red on four consecutive pushes while the local suite was green,
 *   because verify.js ran none of what CI ran.
 *
 *   demo-ai-employee.js went red the first time anyone used the Ask AI
 *   console. It was not registered here, so verify.js reported SOUND while the
 *   demo everybody is told to run was failing.
 *
 *   check-config-drift.js was reporting, correctly, that LiteLLM was running
 *   with a 73-character OpenRouter key while the compose files declared an
 *   empty one. Nobody saw it. The next deploy would have brought the model
 *   router up with no key.
 *
 * Writing a check is the easy half. This is the half that makes it count.
 *
 * Every check-*.js and lint-*.js in infra/scripts must either appear in
 * verify.js, or carry an EXCLUDED marker in its own header saying why not.
 * Being forgotten stops being possible, because staying out of the gate now
 * requires stating your case in writing.
 *
 * To exclude one, put this line in its header comment:
 *   EXCLUDED-FROM-VERIFY: <reason>
 *
 * Usage: node infra/scripts/lint-check-coverage.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const VERIFY = path.join(DIR, 'verify.js');

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  CHECK COVERAGE — every checker is in the gate or says why not       ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

const verifySrc = fs.readFileSync(VERIFY, 'utf8');

const scripts = fs.readdirSync(DIR)
  .filter((f) => /^(check|lint)-.*\.js$/.test(f))
  // This file would otherwise have to register itself, which proves nothing.
  .filter((f) => f !== 'lint-check-coverage.js')
  .sort();

const registered = [];
const excluded = [];
const orphaned = [];

for (const file of scripts) {
  if (verifySrc.includes(file)) { registered.push(file); continue; }

  const head = fs.readFileSync(path.join(DIR, file), 'utf8').slice(0, 4000);
  const marker = head.match(/EXCLUDED-FROM-VERIFY:\s*(.+)/);
  if (marker) { excluded.push([file, marker[1].trim()]); continue; }

  orphaned.push(file);
}

ok(`${scripts.length} checker(s) found`, `${registered.length} in the gate, ${excluded.length} excluded with a reason`);

if (excluded.length) {
  console.log('');
  for (const [file, why] of excluded) {
    console.log(`         excluded  ${file.padEnd(32)}${why.slice(0, 60)}`);
  }
}

console.log('');
if (orphaned.length === 0) {
  ok('no checker is silently outside the gate',
    'every one either runs, or carries a written reason it does not');
} else {
  no(`${orphaned.length} checker(s) run nowhere and give no reason`,
    'each is a defect nobody will be told about');
  for (const f of orphaned) console.log(`         orphaned  ${f}`);
  console.log('\n  Add it to SUITES in verify.js, or put this in its header:');
  console.log('    EXCLUDED-FROM-VERIFY: <why this one should not run in the gate>');
}

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
