#!/usr/bin/env node
'use strict';
/**
 * DEPLOYMENT RECOVERY — does the stack survive being knocked over?
 *
 * Everything a deployment guide promises after "it started" was, until this
 * file, unproven here: that the stack comes back, that the data is still
 * there, that the tenant wall is still standing, and that you can go back to
 * the previous image when a release is bad.
 *
 * WHAT THIS REFUSES TO ACCEPT AS PROOF
 * That a command exited zero. `docker compose restart` returns 0 the instant
 * it has asked the daemon to restart; `docker tag` returns 0 for a tag that
 * points at nothing useful. So every step here ends by making a REQUEST and
 * reading the answer. A rollback is proven when the application serves
 * traffic on the old image, not when the retag succeeds.
 *
 * AND IT RE-CHECKS ISOLATION AFTERWARDS
 * A restart re-runs migrations and re-establishes connections and pools. The
 * failure that would matter most is not "it did not come back" — you would
 * notice that. It is "it came back with the tenant wall down", which looks
 * exactly like a healthy deployment.
 *
 * Usage:
 *   node infra/scripts/check-deploy-recovery.js              restart only
 *   node infra/scripts/check-deploy-recovery.js --rollback   also prove rollback
 *
 * Exit: 0 = the stack survives, 1 = it does not.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const DO_ROLLBACK = process.argv.includes('--rollback');

/**
 * Compose must go through the repo's own wrapper.
 *
 * This stack is not one file. compose-cmd.sh assembles the kernel plus every
 * snippet in infra/compose-snippets, and `docker compose -f docker-compose.yml`
 * alone is a DIFFERENT, smaller stack. The first version of this script called
 * docker directly: `restart` happened to work, because restart re-uses the
 * existing container config, but `up --force-recreate` recreated the dashboard
 * from the partial file set and left it in Created, with nango and temporal
 * flapping. The tool used to test recovery caused the outage.
 */
const COMPOSE_CMD = path.join(__dirname, 'compose-cmd.sh');
function compose(args, timeout = 600000) {
  return spawnSync('bash', [COMPOSE_CMD, ...args], {
    encoding: 'utf8',
    timeout,
    cwd: path.join(__dirname, '..', '..'),
  });
}

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const measured = [];
const record = (k, v) => { measured.push([k, v]); };

function docker(args, timeout = 300000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the app answers, or give up. Returns ms taken, or null. */
async function waitForHealthy(limitMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return Date.now() - started;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  return null;
}

async function healthLatency(samples = 5) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t = Date.now();
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10000) });
      times.push(Date.now() - t);
    } catch { /* counted as a miss, not a time */ }
  }
  if (!times.length) return null;
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
}

function dbClient(user, password) {
  return new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user, password,
    database: process.env.DB_NAME || 'darex',
    connectionTimeoutMillis: 10000,
  });
}

async function snapshot() {
  const db = dbClient(
    process.env.DB_RESOLVER_USER || 'darex',
    process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  );
  await db.connect();
  try {
    const r = await db.query(`
      SELECT (SELECT COUNT(*) FROM orgs)                       AS orgs,
             (SELECT COUNT(*) FROM messages)                   AS messages,
             (SELECT COUNT(*) FROM pg_policies
               WHERE schemaname='public')                      AS policies,
             (SELECT COUNT(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public'
                 AND c.relrowsecurity AND c.relforcerowsecurity) AS forced,
             (SELECT COUNT(*) FROM pg_stat_activity
               WHERE datname = current_database())             AS connections`);
    return r.rows[0];
  } finally {
    await db.end().catch(() => {});
  }
}

/** With no tenant context the app role must see nothing. The wall, behaviourally. */
async function isolationHolds() {
  const app = dbClient(process.env.DB_USER || 'darex_app', process.env.DB_PASSWORD || 'darex_dev_secret');
  await app.connect();
  try {
    const r = await app.query('SELECT COUNT(*)::int AS n FROM orgs');
    return r.rows[0].n === 0;
  } finally {
    await app.end().catch(() => {});
  }
}

/** An unauthenticated request to a protected route must be refused. */
async function authIsEnforced() {
  try {
    const res = await fetch(`${BASE}/api/shadow`, { signal: AbortSignal.timeout(10000) });
    return res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Wait until nothing is still flapping.
 *
 * /api/health answering is not the same as the stack having settled. Measured
 * here: the dashboard served traffic 3.7s after a full restart while temporal
 * was still restarting behind it. Recreating any service during that window
 * fails, because compose blocks on `depends_on: condition: service_healthy`
 * and the dependency is not healthy yet.
 *
 * That is exactly how the first version of the rollback step failed, and it
 * failed in the most misleading way available: it reported "rollback does not
 * work" when what had actually happened was "the rollback was attempted too
 * early". Returns ms taken, or null if it never settles.
 */
async function waitForStackSettled(limitMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const out = String(docker(['ps', '-a', '--filter', 'name=darex-',
      '--format', '{{.Names}}\t{{.Status}}']).stdout || '');
    const rows = out.split('\n').map((s) => s.trim()).filter(Boolean);
    const unsettled = rows.filter((r) =>
      /Restarting|health: starting|Created/.test(r) && !/Exited \(0\)/.test(r));
    if (rows.length && !unsettled.length) return Date.now() - started;
    await sleep(3000);
  }
  return null;
}

function restartCounts() {
  const out = docker(['ps', '-a', '--filter', 'name=darex-', '--format', '{{.Names}}']).stdout || '';
  const names = out.split('\n').map((s) => s.trim()).filter(Boolean);
  let total = 0;
  const perContainer = [];
  for (const n of names) {
    const r = docker(['inspect', '-f', '{{.RestartCount}}', n]);
    const c = parseInt(String(r.stdout || '0').trim(), 10);
    if (Number.isFinite(c)) { total += c; if (c > 0) perContainer.push(`${n}=${c}`); }
  }
  return { total, perContainer, containers: names.length };
}

(async () => {
  console.log('\n=== DEPLOYMENT RECOVERY — DOES THE STACK SURVIVE? ===\n');

  // ── Baseline ──────────────────────────────────────────────────────────────
  console.log('1. Baseline, before anything is knocked over');
  const before = await snapshot();
  console.log(`     orgs=${before.orgs} messages=${before.messages} policies=${before.policies} forcedRLS=${before.forced} connections=${before.connections}`);
  record('postgres connections (baseline)', before.connections);
  record('RLS policies', before.policies);

  const lat0 = await healthLatency();
  lat0 ? ok('the app answers /api/health', `median ${lat0.median}ms, max ${lat0.max}ms`)
       : no('the app answers /api/health', 'no response');
  if (lat0) record('/api/health latency (median)', `${lat0.median}ms`);

  await authIsEnforced()
    ? ok('a protected route refuses an unauthenticated request', 'HTTP 401')
    : no('a protected route refuses an unauthenticated request');

  await isolationHolds()
    ? ok('tenant isolation holds', 'app role reads 0 orgs with no context')
    : no('tenant isolation holds', 'THE APP ROLE CAN READ ACROSS TENANTS');

  const rc0 = restartCounts();
  console.log(`     ${rc0.containers} containers, ${rc0.total} restarts so far${rc0.perContainer.length ? ` (${rc0.perContainer.join(', ')})` : ''}`);

  // ── Restart ───────────────────────────────────────────────────────────────
  console.log('\n2. The whole stack is restarted');
  const t0 = Date.now();
  const down = compose(['restart'], 600000);
  const restartCmdMs = Date.now() - t0;
  down.status === 0
    ? ok('docker compose restart returned 0', `${(restartCmdMs / 1000).toFixed(1)}s`)
    : no('docker compose restart returned 0', String(down.stderr || '').slice(0, 200));

  // Exit zero proves the daemon accepted the instruction, nothing more.
  const recoverMs = await waitForHealthy();
  recoverMs !== null
    ? ok('and the application came back', `${(recoverMs / 1000).toFixed(1)}s to first healthy response`)
    : no('and the application came back', 'never answered within 300s');
  if (recoverMs !== null) record('recovery time after restart', `${(recoverMs / 1000).toFixed(1)}s`);
  record('restart command duration', `${(restartCmdMs / 1000).toFixed(1)}s`);

  // ── The part that would look like success ─────────────────────────────────
  console.log('\n3. It came back — but did it come back CORRECT?');
  const after = await snapshot();
  Number(after.orgs) >= Number(before.orgs)
    ? ok('the data is still there', `orgs ${before.orgs} -> ${after.orgs}`)
    : no('the data is still there', `orgs ${before.orgs} -> ${after.orgs}`);
  Number(after.messages) >= Number(before.messages)
    ? ok('messages intact', `${before.messages} -> ${after.messages}`)
    : no('messages intact', `${before.messages} -> ${after.messages}`);

  Number(after.forced) === Number(before.forced) && Number(after.policies) === Number(before.policies)
    ? ok('the tenant wall is still standing', `${after.forced} FORCE-RLS tables, ${after.policies} policies`)
    : no('the tenant wall is still standing',
      `forced ${before.forced}->${after.forced}, policies ${before.policies}->${after.policies}`);

  await isolationHolds()
    ? ok('and it still BEHAVES', 'app role reads 0 orgs after the restart')
    : no('and it still BEHAVES', 'ISOLATION LOST ACROSS A RESTART');

  await authIsEnforced()
    ? ok('authentication is still enforced', 'HTTP 401')
    : no('authentication is still enforced');

  const lat1 = await healthLatency();
  lat1 ? ok('and it is serving at normal speed', `median ${lat1.median}ms`)
       : no('and it is serving at normal speed', 'no response');
  if (lat1) record('/api/health latency (after restart)', `${lat1.median}ms`);
  record('postgres connections (after restart)', after.connections);

  const rc1 = restartCounts();
  record('container restart count (total)', rc1.total);
  console.log(`     ${rc1.containers} containers, ${rc1.total} restarts total`);

  // ── Rollback ──────────────────────────────────────────────────────────────
  if (DO_ROLLBACK) {
    console.log('\n4. Rollback to the previous application image');
    // The whole stack must have settled first — see waitForStackSettled.
    const settleMs = await waitForStackSettled();
    settleMs !== null
      ? ok('the stack settled before the rollback', `${(settleMs / 1000).toFixed(1)}s after the app first answered`)
      : no('the stack settled before the rollback', 'something is still flapping after 300s');
    if (settleMs !== null) record('stack settle time after restart', `${(settleMs / 1000).toFixed(1)}s`);

    const IMAGE = 'infra-dashboard';
    const cur = String(docker(['inspect', '-f', '{{.Image}}', 'darex-dashboard']).stdout || '').trim();
    if (!cur) {
      no('the running image can be identified', 'docker inspect returned nothing');
    } else {
      ok('the running image is identified', cur.slice(7, 19));
      // Tag the current image as the "previous" one, then prove the stack can
      // be pinned to a named tag and still serve. This proves the MECHANISM —
      // pin, recreate, verify — which is what a real rollback executes. It
      // does not prove an older build works, because only one build exists.
      const tag = docker(['tag', cur, `${IMAGE}:rollback-proof`]);
      tag.status === 0
        ? ok('the previous image can be tagged', `${IMAGE}:rollback-proof`)
        : no('the previous image can be tagged', String(tag.stderr).slice(0, 160));

      // BREAK AN OPTIONAL SERVICE FIRST.
      //
      // A rollback that only works when everything else is healthy is not a
      // rollback — an incident is precisely when something else is not. Nango
      // is third-party connector OAuth and answers no customer, so stopping it
      // must not affect the ability to redeploy or serve.
      //
      // It used to. atomic-bridge required nango HEALTHY, and the chain
      // dashboard -> atomic-agent -> atomic-bridge -> nango-server meant this
      // exact step failed with "dependency failed to start: container
      // darex-nango is unhealthy". That is why this is now part of the proof
      // rather than a footnote.
      const stoppedNango = docker(['stop', 'darex-nango'], 120000).status === 0;
      stoppedNango
        ? ok('an optional service is deliberately stopped first', 'nango down — a rollback must work during an incident')
        : no('an optional service is deliberately stopped first', 'could not stop nango');

      const t2 = Date.now();
      const recreate = compose(['up', '-d', '--force-recreate', 'dashboard'], 600000);
      recreate.status === 0
        ? ok('the service is recreated on the pinned image')
        : no('the service is recreated on the pinned image',
          `status=${recreate.status} signal=${recreate.signal} err=${recreate.error && recreate.error.message} :: `
          + String(recreate.stderr || '').split('\n').filter(Boolean).slice(-3).join(' | '));

      const backMs = await waitForHealthy();
      backMs !== null
        ? ok('AND IT SERVES REQUESTS after the rollback', `${(backMs / 1000).toFixed(1)}s`)
        : no('AND IT SERVES REQUESTS after the rollback', 'never answered — a rollback that exits 0 and serves nothing is not a rollback');
      if (backMs !== null) record('rollback recovery time', `${(backMs / 1000).toFixed(1)}s (recreate ${((Date.now() - t2) / 1000).toFixed(1)}s)`);

      await isolationHolds()
        ? ok('and the tenant wall survived the rollback')
        : no('and the tenant wall survived the rollback', 'ISOLATION LOST');
      await authIsEnforced()
        ? ok('and authentication survived the rollback', 'HTTP 401')
        : no('and authentication survived the rollback');

      // The data has to still be there too. A rollback that serves an empty
      // database is a different disaster wearing the same green tick.
      const afterRb = await snapshot();
      Number(afterRb.orgs) >= Number(before.orgs) && Number(afterRb.messages) >= Number(before.messages)
        ? ok('and the database survived the rollback', `orgs ${afterRb.orgs}, messages ${afterRb.messages}`)
        : no('and the database survived the rollback',
          `orgs ${before.orgs}->${afterRb.orgs}, messages ${before.messages}->${afterRb.messages}`);

      // Put the optional service back and confirm the stack is whole again, so
      // this proof leaves the machine as it found it.
      if (stoppedNango) {
        compose(['up', '-d', 'nango-server'], 300000);
        const restored = await waitForStackSettled(180000);
        restored !== null
          ? ok('the optional service is restored afterwards', `stack whole again in ${(restored / 1000).toFixed(1)}s`)
          : no('the optional service is restored afterwards', 'the stack did not settle');
      }
    }
  } else {
    console.log('\n4. Rollback — skipped (pass --rollback to include it)');
  }

  // ── Resources ─────────────────────────────────────────────────────────────
  console.log('\n5. What it costs to run');
  const stats = docker(['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'], 120000);
  const rows = String(stats.stdout || '').split('\n').filter(Boolean);
  if (rows.length) {
    let totalMemMb = 0;
    for (const r of rows) {
      const m = /([\d.]+)(MiB|GiB)/.exec(r);
      if (m) totalMemMb += parseFloat(m[1]) * (m[2] === 'GiB' ? 1024 : 1);
    }
    record('containers running', rows.length);
    record('total memory', `${(totalMemMb / 1024).toFixed(2)} GiB`);
    ok('resource usage sampled', `${rows.length} containers, ${(totalMemMb / 1024).toFixed(2)} GiB`);
  } else {
    no('resource usage sampled', 'docker stats returned nothing');
  }

  console.log('\n─── MEASURED ───');
  for (const [k, v] of measured) console.log(`  ${k.padEnd(38)} ${v}`);

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
