#!/usr/bin/env node
'use strict';
/**
 * STARTUP COUPLING — can a service that is not on the serving path take the
 * product down, and keep it down?
 *
 * WHY THIS EXISTS
 * atomic-bridge required nango-server to be HEALTHY. Nango is third-party
 * connector OAuth; it answers no customer. But the chain
 *
 *     dashboard -> atomic-agent -> atomic-bridge -> nango-server
 *
 * meant one unhealthy connector service stopped the whole application from
 * starting. Found by attempting an actual rollback:
 *
 *     dependency failed to start: container darex-nango is unhealthy
 *
 * So the application could not be rolled back while an auxiliary service was
 * down — and an incident is exactly when both of those are true at once. The
 * recovery path was coupled to something not on the serving path, which turns
 * a degraded feature into an outage you cannot exit.
 *
 * THE RULE
 * `condition: service_healthy` is a promise that the depender CANNOT FUNCTION
 * without the dependency. It is not a scheduling hint and it is not free: it
 * makes the dependency's health a precondition of your own existence.
 *
 * So every such edge must be listed below with a reason. Anything not listed
 * must be `service_started`, which orders startup without coupling liveness.
 * Adding a hard dependency is then a decision somebody writes down, rather
 * than the default that happens when nobody thinks about it.
 *
 * Usage: node infra/scripts/lint-startup-coupling.js
 * Exit:  0 = every hard dependency is justified, 1 = one is not.
 */
const fs = require('fs');
const path = require('path');

const COMPOSE = path.join(__dirname, '..', 'docker-compose.yml');

/**
 * service -> dependency : why the depender genuinely cannot run without it.
 * Keep this SHORT. A long list means the rule has stopped meaning anything.
 */
const JUSTIFIED = {
  'pgbouncer -> postgres':                 'a connection pooler with no database pools nothing',
  'temporal -> postgres':                  'Temporal stores its own workflow state there',
  'supertokens -> postgres':               'the auth service stores users and sessions there',
  'litellm -> postgres':                   'the proxy stores its spend log and virtual keys there',
  'nango-server -> postgres':              'stores connector credentials there',
  'nango-server -> redis':                 'its job queue',
  'inbox -> postgres':                     'every inbound message is written on arrival',
  'atomic-bridge -> postgres':             'resolves tenant and tool state on every call',
  'atomic-bridge -> pgbouncer':            'all bridge queries go through the pooler',
  'atomic-agent -> atomic-bridge':         'the agent has no tools at all without the bridge',
  'worker -> postgres':                    'every activity reads or writes tenant data',
  'worker -> pgbouncer':                   'all worker queries go through the pooler',
  'worker -> temporal':                    'the worker exists only to poll a Temporal task queue',
  'worker -> atomic-agent':                'the worker runs agent turns; without it there is no work it can do',
  'dashboard -> postgres':                 'every page reads tenant data',
  'dashboard -> pgbouncer':                'all dashboard queries go through the pooler',
  'dashboard -> supertokens':              'nobody can sign in, so no page is reachable',
  'dashboard -> redis':                    'sessions and rate limiting',
  'langfuse-server -> postgres':           'observability subsystem, own storage',
  'langfuse-server -> langfuse-clickhouse':'observability subsystem, own storage',
  'langfuse-server -> langfuse-redis':     'observability subsystem, own queue',
  'langfuse-worker -> langfuse-server':    'observability subsystem, its own API',
  'langfuse-worker -> langfuse-redis':     'observability subsystem, own queue',
};

/** Parse `service -> dependency : condition` out of the compose file. */
function parseDependsOn(src) {
  const lines = src.split('\n');
  const edges = [];
  let service = null;
  let dep = null;
  let inDepends = false;

  for (const line of lines) {
    const svc = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (svc) { service = svc[1]; inDepends = false; dep = null; continue; }
    if (/^    depends_on:\s*$/.test(line)) { inDepends = true; dep = null; continue; }
    // Any other key at the service's own indent level ends the block.
    if (inDepends && /^    [a-z_]/i.test(line)) { inDepends = false; dep = null; continue; }
    if (!inDepends) continue;

    const d = /^      ([a-z0-9-]+):\s*$/.exec(line);
    if (d) { dep = d[1]; continue; }
    const c = /^\s*condition:\s*(\S+)\s*$/.exec(line);
    if (c && service && dep) edges.push({ service, dep, condition: c[1] });
  }
  return edges;
}

if (process.argv.includes('--self-test')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  const t = (n, fn) => {
    try { fn(); pass++; console.log(`  [PASS] ${n}`); }
    catch (e) { fail++; console.log(`  [FAIL] ${n} — ${e.message}`); }
  };
  console.log('\n=== STARTUP COUPLING — SELF TEST ===\n');

  t('parses a service, dependency and condition', () => {
    const e = parseDependsOn([
      '  dashboard:',
      '    depends_on:',
      '      postgres:',
      '        condition: service_healthy',
      '    ports:',
      '      - "3000:3000"',
    ].join('\n'));
    assert.deepEqual(e, [{ service: 'dashboard', dep: 'postgres', condition: 'service_healthy' }]);
  });

  t('a ports entry after depends_on is not read as a dependency', () => {
    const e = parseDependsOn([
      '  a:', '    depends_on:', '      b:', '        condition: service_started',
      '    environment:', '      condition: service_healthy',
    ].join('\n'));
    assert.equal(e.length, 1, 'the environment key must close the depends_on block');
    assert.equal(e[0].condition, 'service_started');
  });

  t('several dependencies on one service are all captured', () => {
    const e = parseDependsOn([
      '  x:', '    depends_on:',
      '      p:', '        condition: service_healthy',
      '      q:', '        condition: service_started',
    ].join('\n'));
    assert.equal(e.length, 2);
    assert.equal(e[1].dep, 'q');
  });

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

const edges = parseDependsOn(fs.readFileSync(COMPOSE, 'utf8'));
const hard = edges.filter((e) => e.condition === 'service_healthy');
const unjustified = hard.filter((e) => !JUSTIFIED[`${e.service} -> ${e.dep}`]);

// A justification for an edge that no longer exists is stale bookkeeping and
// hides the next real one.
const present = new Set(edges.map((e) => `${e.service} -> ${e.dep}`));
const stale = Object.keys(JUSTIFIED).filter((k) => !present.has(k));

if (unjustified.length) {
  console.log('\n  [FAIL] hard startup dependencies with no written reason:\n');
  for (const e of unjustified) console.log(`    ${e.service} -> ${e.dep}`);
  console.log(
    '\n  `condition: service_healthy` says the depender CANNOT FUNCTION without\n' +
    '  the dependency, and makes that dependency\'s health a precondition of\n' +
    '  your own. If that is true, add a line to JUSTIFIED in this file saying\n' +
    '  why. If it is not, use `condition: service_started`.\n' +
    '\n  This rule exists because atomic-bridge -> nango-server was healthy, and\n' +
    '  one unhealthy connector service made the product impossible to roll back.\n',
  );
  process.exit(1);
}

if (stale.length) {
  console.log('\n  [FAIL] justifications for dependencies that no longer exist:\n');
  for (const k of stale) console.log(`    ${k}`);
  console.log('\n  Remove them — stale entries hide the next real coupling.\n');
  process.exit(1);
}

console.log(`  [PASS] ${hard.length} hard dependencies, all justified; `
  + `${edges.length - hard.length} ordered without coupling`);
console.log('  passed 1 / 1');
process.exit(0);
