#!/usr/bin/env node
'use strict';

/**
 * I6 — connector 401s still log (DoD: forced outbound 401 is visible).
 *
 *   node infra/scripts/alerting-connector-401s.js
 *   node infra/scripts/alerting-connector-401s.js --require-401
 *
 * Default: PASS only if worker/dashboard/bridge logs are readable.
 * Zero 401s in the window is reported, not faked as "healthy connectors".
 * --require-401: FAIL when no 401/connected:false line is found (drill).
 */

const { execSync } = require('child_process');

const REQUIRE_401 = process.argv.includes('--require-401');
const SINCE = process.env.ALERT_LOG_SINCE || '24h';
const CONTAINERS = ['darex-worker', 'darex-dashboard', 'darex-atomic-bridge'];
const PATTERN = '401|notConnected|connected.:.false|status.:.error';

let fail = 0;
let hits = 0;
let readable = 0;

console.log('\n=== Alerting — connector 401s ===\n');

for (const c of CONTAINERS) {
  try {
    const status = execSync(`docker inspect --format="{{.State.Status}}" ${c}`, {
      encoding: 'utf8',
    }).trim();
    if (status !== 'running') {
      console.log(`  [FAIL] ${c} state=${status} (cannot read 401 logs)`);
      fail = 1;
      continue;
    }
    const logs = execSync(`docker logs ${c} --since ${SINCE} 2>&1`, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    readable += 1;
    const lines = logs.split(/\r?\n/).filter((line) => new RegExp(PATTERN).test(line));
    hits += lines.length;
    console.log(`  [INFO] ${c}: ${lines.length} matching line(s) in last ${SINCE}`);
    if (lines.length > 0) {
      console.log(`         sample: ${lines[lines.length - 1].slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`  [FAIL] cannot read logs for ${c}: ${(e.message || 'unknown').split('\n')[0]}`);
    fail = 1;
  }
}

if (readable === 0) {
  console.log('  [FAIL] no container logs readable — not treating this as green');
  fail = 1;
} else if (REQUIRE_401 && hits === 0) {
  console.log('  [FAIL] --require-401 set and no 401/notConnected lines found (drill)');
  fail = 1;
} else if (hits === 0) {
  console.log('  [PASS] logs readable; no 401/notConnected lines in window (not a fake all-clear on connectors)');
} else {
  console.log(`  [PASS] 401/notConnected lines are logging (${hits} hit(s))`);
}

console.log(fail ? '\n  connector 401 probe FAILED\n' : '\n  connector 401 probe ok\n');
process.exit(fail);
