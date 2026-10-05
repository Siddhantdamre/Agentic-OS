#!/usr/bin/env node
// CI dependency-audit gate. Fails on any high/critical production advisory
// that is not in ACCEPTED. pnpm 9.0.0 ignores pnpm.auditConfig.ignoreGhsas,
// so the allowlist lives here instead.
const { spawnSync } = require('node:child_process');

// Accepted, tracked debt. Remove entries as they are fixed.
const ACCEPTED = {
  // next@14.2.35 — fix needs the Next 15.5.24+ major upgrade of apps/dashboard.
  'GHSA-p293-qw3h-jr36': 'next 14 -> 15 upgrade pending',
  'GHSA-2xp9-vwfh-vxw4': 'next 14 -> 15 upgrade pending',
  'GHSA-h25m-26qc-wcjf': 'next 14 -> 15 upgrade pending',
  'GHSA-q4gf-8mx6-v5v3': 'next 14 -> 15 upgrade pending',
  'GHSA-8h8q-6873-q5fj': 'next 14 -> 15 upgrade pending',
  'GHSA-c4j6-fc7j-m34r': 'next 14 -> 15 upgrade pending',
  'GHSA-36qx-fr4f-26g5': 'next 14 -> 15 upgrade pending',
  'GHSA-m99w-x7hq-7vfj': 'next 14 -> 15 upgrade pending',
  'GHSA-89xv-2m56-2m9x': 'next 14 -> 15 upgrade pending',
  'GHSA-p9j2-gv94-2wf4': 'next 14 -> 15 upgrade pending',
  // braces <=3.0.3 — no patched version exists upstream (via daytona sdk > fast-glob).
  'GHSA-vfj7-8cjw-p6xm': 'no upstream patch',
};

const r = spawnSync('pnpm', ['audit', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(r.stdout);
} catch (e) {
  console.error('audit-gate: could not parse pnpm audit output:', r.stderr || r.stdout);
  process.exit(2);
}

const blocking = Object.values(report.advisories || {}).filter(
  (a) => (a.severity === 'high' || a.severity === 'critical') && !ACCEPTED[a.github_advisory_id],
);
for (const a of blocking) {
  console.error(`${a.severity} ${a.module_name} ${a.github_advisory_id} ${a.title}\n  ${a.url}`);
}
if (blocking.length) {
  console.error(`audit-gate: ${blocking.length} un-accepted high/critical advisories`);
  process.exit(1);
}
console.log('audit-gate: no un-accepted high/critical production advisories');
