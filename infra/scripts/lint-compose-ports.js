#!/usr/bin/env node
'use strict';
/**
 * PRODUCTION PORT BINDINGS — does the overlay actually replace them?
 *
 * The production overlay exists to bind data and admin ports to loopback so
 * they are not on the public internet. On a clean Ubuntu machine the real
 * deploy died with:
 *
 *   failed to bind host port 127.0.0.1:9090/tcp: address already in use
 *
 * The cause is that Docker Compose MERGES sequence values across files rather
 * than replacing them. The overlay's own header said "later wins", which is
 * true for scalars and false for lists. So every `ports:` entry in the overlay
 * was APPENDED to the kernel's, and the merged config published fifteen ports
 * twice.
 *
 * The outage was the smaller half of the problem. The kernel publishes
 * "5432:5432" on all interfaces; the overlay's "127.0.0.1:5432:5432" was
 * supposed to replace it. Appended instead, a production deployment that had
 * managed to start would have had POSTGRES ON THE PUBLIC INTERNET — the exact
 * thing the file was written to prevent.
 *
 * This lint renders the merged production config and fails if any host port is
 * published more than once, or if any port is published on a non-loopback
 * interface. It needs Docker only to run `compose config`, which does not
 * start anything.
 *
 * Usage: node infra/scripts/lint-compose-ports.js
 * Exit:  0 = every published port is unique and loopback-bound, 1 = not
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Ports that are SUPPOSED to be reachable from outside the host, if any.
// Empty: the documented topology puts Caddy in front of 127.0.0.1:3000, so
// nothing in the compose stack should bind a public interface itself.
const PUBLIC_ALLOWED = new Set([]);

let merged;
try {
  merged = execFileSync(
    'docker',
    ['compose', '-f', 'infra/docker-compose.yml', '-f', 'deploy/docker-compose.prod.yml', 'config'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // compose interpolates ${...}; supply throwaway values so rendering does
      // not fail for want of secrets. This never starts a container.
      env: {
        ...process.env,
        DB_PASSWORD: 'lint', APP_DB_PASSWORD: 'lint', SUPERTOKENS_API_KEY: 'lint',
        DAREX_SESSION_SECRET: 'lint', LITELLM_MASTER_KEY: 'lint', OPENROUTER_API_KEY: 'lint',
        ATOMIC_AGENT_API_KEY: 'lint', NANGO_SECRET_KEY: '00000000-0000-0000-0000-000000000000',
      },
    },
  );
} catch (err) {
  const msg = String(err.stderr || err.message || '');
  // Docker absent is not a failing lint — it is an unrunnable one. Say which.
  if (/not found|not recognized|daemon|Cannot connect/i.test(msg)) {
    console.log('  [SKIP] docker unavailable — cannot render the merged compose config');
    process.exit(0);
  }
  console.log(`  [FAIL] could not render merged compose config:\n${msg.slice(0, 500)}`);
  process.exit(1);
}

// Walk the rendered YAML for published/host_ip pairs. compose config normalises
// every short form into this long form, so a simple scan is exact here.
const entries = [];
const lines = merged.split('\n');
for (let i = 0; i < lines.length; i++) {
  const pub = /^\s*published:\s*"?(\d+)"?\s*$/.exec(lines[i]);
  if (!pub) continue;
  let hostIp = '0.0.0.0';
  // host_ip sits within a few lines of published in the same list item.
  for (let j = Math.max(0, i - 4); j < Math.min(lines.length, i + 5); j++) {
    const ip = /^\s*host_ip:\s*(\S+)\s*$/.exec(lines[j]);
    if (ip) { hostIp = ip[1]; break; }
  }
  entries.push({ port: pub[1], hostIp });
}

const counts = new Map();
for (const e of entries) counts.set(e.port, (counts.get(e.port) || 0) + 1);
const duplicates = [...counts.entries()].filter(([, n]) => n > 1);

const publicBinds = entries.filter(
  (e) => !/^127\./.test(e.hostIp) && e.hostIp !== 'localhost' && !PUBLIC_ALLOWED.has(e.port),
);

let failed = false;

if (duplicates.length) {
  failed = true;
  console.log('\n  [FAIL] ports published more than once in the merged production config:\n');
  for (const [port, n] of duplicates.sort((a, b) => a[0] - b[0])) {
    console.log(`    ${port}  published ${n} times`);
  }
  console.log(
    '\n  Compose APPENDS list values across files. Tag the overlay\'s lists\n' +
    '  with !override so they replace rather than extend:\n\n' +
    '      ports: !override\n' +
    '        - "127.0.0.1:5432:5432"\n',
  );
}

if (publicBinds.length) {
  failed = true;
  console.log('\n  [FAIL] production ports bound to a non-loopback interface:\n');
  for (const e of publicBinds) console.log(`    ${e.hostIp}:${e.port}`);
  console.log('\n  The documented topology is Caddy in front of 127.0.0.1:3000.\n');
}

if (failed) process.exit(1);

console.log(`  [PASS] ${entries.length} published ports, all unique and loopback-bound`);
console.log('  passed 1 / 1');
process.exit(0);
