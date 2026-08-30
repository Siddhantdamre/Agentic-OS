#!/usr/bin/env node
'use strict';
/**
 * CONFIG DRIFT — is what is RUNNING what the compose file DECLARES?
 *
 * WHY THIS EXISTS
 * SuperTokens was found in a permanent restart loop:
 *
 *     FATAL: password authentication failed for user "darex"
 *
 * Not a healthcheck problem, not a timing problem — the process was starting,
 * failing to open a database pool, and exiting cleanly, over and over. The
 * container had been created with the APP role's password while connecting as
 * the SUPERUSER. Nango and Temporal held the same wrong value.
 *
 * The compose file was correct the whole time. `compose config` resolved the
 * right password; the running containers had been created at some earlier
 * moment when the environment differed, and nothing ever compared the two
 * again. Recreating them fixed it instantly.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS
 * SuperTokens is authentication — a genuine serving-path dependency, and one
 * of the few things this stack SHOULD refuse to start without. So this drift
 * did not degrade a feature; it made the product unable to start and unable to
 * be rolled back. A rollback attempt failed with exactly this, one service
 * deep:
 *
 *     dependency failed to start: container darex-supertokens is unhealthy
 *
 * A stack whose running containers no longer match its own declared config is
 * a stack that cannot be redeployed, and you find out during an incident.
 *
 * NO SECRET IS EVER PRINTED. Values are compared as SHA-256 digests and
 * reported as "differs", with lengths only. The point is to detect drift, not
 * to display credentials.
 *
 * Usage: node infra/scripts/check-config-drift.js
 * Exit:  0 = running matches declared, 1 = drift, 2 = cannot check
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COMPOSE_CMD = path.join(__dirname, 'compose-cmd.sh');

/**
 * Which keys are worth comparing.
 *
 * Not every environment variable: compose injects defaults and the runtime
 * adds its own, so a blanket comparison is all noise. These are the ones whose
 * drift takes the product down — credentials and the endpoints they are used
 * against.
 */
const WATCHED = /(PASSWORD|SECRET|_KEY|DATABASE_URL|CONNECTION_URI|_USER)$/;

// Keys that are legitimately different at runtime, or are not secrets at all.
const IGNORE = new Set(['POSTGRES_USER', 'DB_USER', 'NANGO_DB_USER', 'POSTGRESQL_USER']);

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12);

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, timeout: 180000, ...opts });
}

console.log('\n=== CONFIG DRIFT — IS WHAT RUNS WHAT IS DECLARED? ===\n');

const cfg = sh('bash', [COMPOSE_CMD, 'config']);
if (cfg.status !== 0 || !cfg.stdout) {
  console.log('  [SKIP] could not render the compose config — cannot compare');
  console.log(`         ${String(cfg.stderr || '').split('\n')[0]}`);
  process.exit(2);
}

// Parse `services: <name>: environment: KEY: value` out of the rendered YAML.
// compose config normalises environment into a mapping, so this is exact.
const declared = new Map();   // service -> Map(key -> value)
{
  const lines = cfg.stdout.split('\n');
  let service = null;
  let inEnv = false;
  let containerName = null;
  const names = new Map();    // service -> container_name
  for (const line of lines) {
    const svc = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (svc) {
      service = svc[1]; inEnv = false; containerName = null;
      if (!declared.has(service)) declared.set(service, new Map());
      continue;
    }
    if (!service) continue;
    const cn = /^    container_name:\s*(\S+)\s*$/.exec(line);
    if (cn) { names.set(service, cn[1]); continue; }
    if (/^    environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^    \S/.test(line)) { inEnv = false; }
    if (!inEnv) continue;
    const kv = /^      ([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) {
      let v = kv[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      declared.get(service).set(kv[1], v);
    }
  }
  declared.set('__names__', names);
}

const names = declared.get('__names__');
declared.delete('__names__');

let checkedServices = 0;
let checkedKeys = 0;
const drifted = [];

for (const [service, env] of declared) {
  const container = names.get(service);
  if (!container) continue;

  const insp = sh('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
  if (insp.status !== 0) continue;   // not running is not drift

  const actual = new Map();
  for (const l of String(insp.stdout).split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) actual.set(l.slice(0, i), l.slice(i + 1));
  }
  checkedServices++;

  for (const [k, want] of env) {
    if (!WATCHED.test(k) || IGNORE.has(k)) continue;
    if (!actual.has(k)) continue;     // not injected at all is a different problem
    checkedKeys++;
    const got = actual.get(k);
    if (got !== want) {
      drifted.push({
        container, key: k,
        declared: `${digest(want)} (len ${want.length})`,
        running: `${digest(got)} (len ${got.length})`,
      });
    }
  }
}

if (checkedServices === 0) {
  console.log('  [SKIP] no declared containers are running — nothing to compare');
  process.exit(2);
}

if (drifted.length) {
  no(`${drifted.length} setting(s) differ between the running stack and the compose file`);
  console.log('');
  for (const d of drifted) {
    console.log(`    ${d.container}  ${d.key}`);
    console.log(`      declared  ${d.declared}`);
    console.log(`      running   ${d.running}`);
  }
  console.log(
    '\n  These containers were created when the environment differed and have\n' +
    '  not been recreated since. The stack cannot be redeployed or rolled back\n' +
    '  in this state — the next `up -d` replaces them and they may fail to\n' +
    '  start, which is how SuperTokens ended up in a crash loop with\n' +
    '  "password authentication failed for user darex".\n' +
    '\n  Fix: bash infra/scripts/compose-cmd.sh up -d --force-recreate <service>\n',
  );
} else {
  ok(`every watched setting matches`, `${checkedKeys} key(s) across ${checkedServices} running service(s)`);
}

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
