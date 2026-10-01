#!/usr/bin/env node
'use strict';

/**
 * I6 — run all alerting probes. Any FAIL exits 1. Never ORs into a fake pass.
 *
 *   node infra/scripts/alerting-run.js
 *
 * Callers: operators (deploy/README.md, infra/scripts/alerting-placeholder.md).
 */

const { spawnSync } = require('child_process');
const path = require('path');

const scripts = [
  'alerting-queue-lag.js',
  'alerting-connector-401s.js',
  'alerting-rls-job.js',
  'alerting-langfuse-ingest.js',
];

let failed = 0;
console.log('\n=== Darex alerting probes (I6) ===\n');

for (const name of scripts) {
  const file = path.join(__dirname, name);
  const r = spawnSync(process.execPath, [file, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    failed += 1;
    console.log(`  [FAIL] ${name} exit=${r.status === null ? 'signal' : r.status}`);
  }
}

if (failed > 0) {
  console.log(`\n  ${failed}/${scripts.length} probe(s) FAILED — not green\n`);
  process.exit(1);
}
console.log(`\n  ${scripts.length}/${scripts.length} probes exited 0\n`);
