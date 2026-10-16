#!/usr/bin/env node
'use strict';

/**
 * I6 — Langfuse ingest path is up (dedicated langfuse-redis, not the SSE bus).
 *
 *   node infra/scripts/alerting-langfuse-ingest.js
 *
 * FAIL if Langfuse health, ClickHouse, or langfuse-redis cannot be reached.
 * Does not claim traces persisted unless /api/public/health says so.
 */

const { execSync } = require('child_process');
const http = require('http');

let fail = 0;

console.log('\n=== Alerting — Langfuse ingest ===\n');

function checkHttp(name, url) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = http.get(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, timeout: 5000 },
      (res) => {
        if (res.statusCode === 200) {
          console.log(`  [PASS] ${name} (HTTP 200)`);
        } else {
          console.log(`  [FAIL] ${name} — HTTP ${res.statusCode}`);
          fail = 1;
        }
        res.resume();
        resolve();
      },
    );
    req.on('error', (err) => {
      console.log(`  [FAIL] ${name} — ${err.message}`);
      fail = 1;
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      console.log(`  [FAIL] ${name} — timeout`);
      fail = 1;
      resolve();
    });
  });
}

try {
  const st = execSync('docker inspect --format="{{.State.Status}}" darex-langfuse-redis', {
    encoding: 'utf8',
  }).trim();
  if (st !== 'running') {
    console.log(`  [FAIL] darex-langfuse-redis state=${st}`);
    fail = 1;
  } else {
    const pong = execSync('docker exec darex-langfuse-redis redis-cli ping', { encoding: 'utf8' }).trim();
    if (pong === 'PONG') {
      console.log('  [PASS] langfuse-redis PING (not the SSE bus)');
    } else {
      console.log(`  [FAIL] langfuse-redis ping=${pong}`);
      fail = 1;
    }
  }
} catch (e) {
  console.log('  [FAIL] langfuse-redis not reachable');
  fail = 1;
}

try {
  const st = execSync('docker inspect --format="{{.State.Status}}" darex-langfuse-clickhouse', {
    encoding: 'utf8',
  }).trim();
  if (st !== 'running') {
    console.log(`  [FAIL] darex-langfuse-clickhouse state=${st}`);
    fail = 1;
  } else {
    const q = execSync(
      "docker exec darex-langfuse-clickhouse clickhouse-client --user langfuse --password langfuse_dev_secret --query 'SELECT 1'",
      { encoding: 'utf8' },
    ).trim();
    if (q === '1') {
      console.log('  [PASS] ClickHouse SELECT 1');
    } else {
      console.log(`  [FAIL] ClickHouse SELECT 1 => ${q}`);
      fail = 1;
    }
  }
} catch (e) {
  console.log('  [FAIL] ClickHouse not reachable');
  fail = 1;
}

checkHttp('Langfuse /api/public/health', 'http://localhost:3002/api/public/health').then(() => {
  console.log(fail ? '\n  Langfuse ingest probe FAILED\n' : '\n  Langfuse ingest probe ok\n');
  process.exit(fail);
});
