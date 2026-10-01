#!/usr/bin/env node
'use strict';

/**
 * I6 — Temporal / Redis queue lag. Honest fail if we cannot inspect.
 *
 *   node infra/scripts/alerting-queue-lag.js
 *
 * Env: QUEUE_LAG_MAX (default 50 running Temporal workflows).
 */

const { execSync } = require('child_process');

const MAX = parseInt(process.env.QUEUE_LAG_MAX || '50', 10);
let fail = 0;

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log('\n=== Alerting — queue lag ===\n');

try {
  const status = execSync('docker inspect --format="{{.State.Status}}" darex-temporal', {
    encoding: 'utf8',
  }).trim();
  if (status !== 'running') {
    console.log(`  [FAIL] darex-temporal state=${status}`);
    process.exit(1);
  }
} catch (e) {
  console.log('  [FAIL] darex-temporal is not running (cannot measure lag)');
  process.exit(1);
}

let running = null;
try {
  const out = run(
    'docker exec darex-temporal temporal workflow count --address temporal:7233 --query \'ExecutionStatus="Running"\'',
  );
  const m = out.match(/(\d+)/);
  if (!m) {
    console.log(`  [FAIL] could not parse running count from: ${out.trim()}`);
    fail = 1;
  } else {
    running = parseInt(m[1], 10);
    if (running > MAX) {
      console.log(`  [FAIL] running workflows=${running} exceeds QUEUE_LAG_MAX=${MAX}`);
      fail = 1;
    } else {
      console.log(`  [PASS] running workflows=${running} (threshold ${MAX})`);
    }
  }
} catch (e) {
  const msg = (e.stderr || e.message || '').toString().trim();
  console.log(`  [FAIL] temporal workflow count failed: ${msg || 'unknown error'}`);
  fail = 1;
}

try {
  const pong = run('docker exec darex-redis redis-cli ping').trim();
  if (pong !== 'PONG') {
    console.log(`  [FAIL] Nango redis ping=${pong}`);
    fail = 1;
  } else {
    console.log('  [PASS] Nango redis PING');
  }
} catch (e) {
  console.log('  [FAIL] darex-redis not reachable');
  fail = 1;
}

console.log(fail ? '\n  queue lag probe FAILED\n' : '\n  queue lag probe ok\n');
process.exit(fail);
